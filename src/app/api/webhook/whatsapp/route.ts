import { NextResponse } from 'next/server';
import { getAgentByWhatsApp, getConversationHistory, saveMessage } from '@/services/agentService';
import { buildSystemPrompt } from '@/services/promptBuilder';
import { gemini } from '@/lib/gemini';
import { twilioClient } from '@/lib/twilio';

export async function POST(req: Request) {
  try {
    const text = await req.text();
    const params = new URLSearchParams(text);
    
    const from = params.get('From') || '';
    const to = params.get('To') || '';
    const body = params.get('Body') || '';

    if (!from || !to || !body) {
      return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
    }

    // 1. Encontrar agente
    const cleanToNumber = to.replace('whatsapp:', '');
    const cleanFromNumber = from.replace('whatsapp:', '');
    
    const agent = await getAgentByWhatsApp(cleanToNumber);

    if (!agent) {
      console.warn(`Agent not found for number: ${cleanToNumber}`);
      await sendMessageViaTwilio(from, to, 'Lo siento, este servicio no está disponible en este momento.');
      return NextResponse.json({ success: true }); // Retornar 200 a Twilio siempre
    }

    // Validación de status published (Excepto si es sandbox test)
    if (agent.status !== 'published' && cleanToNumber !== '+14155238886') {
      console.warn(`Agent ${agent.id} is not published yet.`);
      await sendMessageViaTwilio(from, to, 'El asistente virtual de este negocio aún no está publicado.');
      return NextResponse.json({ success: true });
    }

    const agentId = agent.id;
    const conversationId = cleanFromNumber;

    // 2. Recuperar historial (últimos 10)
    const history = await getConversationHistory(agentId, conversationId);
    
    // 3. Guardar el mensaje del usuario
    await saveMessage(agentId, conversationId, 'user', body);

    // 4. Preparar Prompt y Llamada a Gemini
    const systemPrompt = buildSystemPrompt(agent.data);
    
    const geminiMessages = history.map((msg: any) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));
    
    // Agregar el mensaje actual
    geminiMessages.push({ role: 'user', parts: [{ text: body }] });

    try {
      const completion = await gemini.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: geminiMessages,
        config: {
          systemInstruction: systemPrompt,
        }
      });

      // Asegurarnos de que el texto viene en la respuesta
      const responseContent = completion.text || '';
      
      // 5. Procesar etiquetas (Actions)
      let cleanResponse = responseContent;
      
      const hasHandoff = cleanResponse.includes('[ACTION:HANDOFF]');
      if (hasHandoff) {
        cleanResponse = cleanResponse.replace(/\[ACTION:HANDOFF\]/g, '').trim();
        
        // Ejecutar Handoff
        const handoffNumber = agent.data?.desvioEquipo?.responsable || agent.data?.modules?.scheduling?.notificationNumber;
        if (handoffNumber) {
          const summary = `Derivación solicitada.\nCliente: ${cleanFromNumber}\nÚltimo mensaje: "${body}"\nRespuesta IA: "${cleanResponse}"`;
          await sendMessageViaTwilio(`whatsapp:${handoffNumber}`, `whatsapp:${cleanToNumber}`, summary);
        } else {
          console.log(`Handoff requested but no responsible number found for agent ${agentId}`);
        }
      }

      if (cleanResponse.includes('[ACTION:SCHEDULE]')) {
        console.log(`[LOG] Agendamiento solicitado en conversación ${conversationId} con agente ${agentId}`);
        cleanResponse = cleanResponse.replace(/\[ACTION:SCHEDULE\]/g, '').trim();
      }

      if (cleanResponse.includes('[ACTION:REVIEW]')) {
        console.log(`[LOG] Solicitud de reseña en conversación ${conversationId} con agente ${agentId}`);
        cleanResponse = cleanResponse.replace(/\[ACTION:REVIEW\]/g, '').trim();
      }

      if (cleanResponse.includes('[ACTION:TRACKING]')) {
        console.log(`[LOG] Tracking (Lead alto valor) en conversación ${conversationId} con agente ${agentId}`);
        cleanResponse = cleanResponse.replace(/\[ACTION:TRACKING\]/g, '').trim();
      }

      // 6. Enviar a Twilio
      await sendMessageViaTwilio(from, to, cleanResponse);

      // 7. Guardar la respuesta en Firestore
      await saveMessage(agentId, conversationId, 'assistant', cleanResponse);

      return NextResponse.json({ success: true });

    } catch (llmError) {
      console.error('Error llamando a Gemini:', llmError);
      await sendMessageViaTwilio(from, to, 'Disculpá, estoy teniendo problemas técnicos. Intentá de nuevo en un momento.');
      return NextResponse.json({ success: true });
    }

  } catch (error) {
    console.error('Error procesando webhook:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

async function sendMessageViaTwilio(to: string, from: string, body: string) {
  try {
    await twilioClient.messages.create({
      body,
      from,
      to
    });
  } catch (error) {
    console.error('Twilio Error:', error);
  }
}
