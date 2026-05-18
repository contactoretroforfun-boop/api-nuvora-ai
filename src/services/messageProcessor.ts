import { getAgentByWhatsApp, getConversationHistory, saveMessage } from '@/services/agentService';
import { buildSystemPrompt } from '@/services/promptBuilder';
import { gemini } from '@/lib/gemini';
import { dispatchOutboundMessage } from '@/services/outboundRouter';

export interface UnifiedIncomingMessage {
  messageId: string;
  from: string;      // E.164 sanitizado (ej: +59899123456)
  to: string;        // E.164 destinatario (ej: +14155238886)
  body: string;
  provider: 'twilio' | 'meta';
  rawPayload: any;
}

/**
 * Core de procesamiento agnóstico. Ejecuta el pipeline del agente
 * independientemente del proveedor de mensajería (Twilio o Meta).
 */
export async function processIncomingMessage(incoming: UnifiedIncomingMessage): Promise<{ success: boolean; error?: string }> {
  const { from, to, body, provider } = incoming;

  try {
    // 1. Encontrar agente
    const cleanToNumber = to.replace('whatsapp:', '').trim();
    const cleanFromNumber = from.replace('whatsapp:', '').trim();

    const agent = await getAgentByWhatsApp(cleanToNumber);

    if (!agent) {
      console.warn(`[Message Processor] Agent not found for number: ${cleanToNumber}`);
      await dispatchOutboundMessage({
        recipient: from,
        sender: to,
        body: 'Lo siento, este servicio no está disponible en este momento.',
        provider,
      });
      return { success: false, error: 'Agent not found' };
    }

    // 2. Validación de status published (Excepto si es test de sandbox)
    const isSandboxTest = cleanToNumber === '+14155238886';
    if (agent.status !== 'published' && !isSandboxTest) {
      console.warn(`[Message Processor] Agent ${agent.id} is not published yet (status: ${agent.status}).`);
      await dispatchOutboundMessage({
        recipient: from,
        sender: to,
        body: 'El asistente virtual de este negocio aún no está publicado.',
        provider,
        agentConfig: agent,
      });
      return { success: true };
    }

    const agentId = agent.id;
    const conversationId = cleanFromNumber;

    // 3. Recuperar historial (últimos 10 mensajes)
    const history = await getConversationHistory(agentId, conversationId);

    // 4. Guardar el mensaje entrante del usuario en base de datos
    await saveMessage(agentId, conversationId, 'user', body);

    // 5. Preparar Prompt y Llamar a Gemini API
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

      const responseContent = completion.text || '';
      let cleanResponse = responseContent;

      // 6. Detección y procesamiento de etiquetas de acción (Hardening de Módulos)
      const hasHandoff = cleanResponse.includes('[ACTION:HANDOFF]');
      if (hasHandoff) {
        cleanResponse = cleanResponse.replace(/\[ACTION:HANDOFF\]/g, '').trim();

        // Ejecutar Handoff (Derivación)
        const handoffNumber = agent.data?.desvioEquipo?.responsable || agent.data?.modules?.scheduling?.notificationNumber;
        if (handoffNumber) {
          const summary = `Derivación solicitada.\nCliente: ${cleanFromNumber}\nÚltimo mensaje: "${body}"\nRespuesta IA: "${cleanResponse}"`;
          
          await dispatchOutboundMessage({
            recipient: handoffNumber,
            sender: to,
            body: summary,
            provider,
            agentConfig: agent,
          });
        } else {
          console.warn(`[Message Processor] Handoff requested but no responsible number found for agent: ${agentId}`);
        }
      }

      if (cleanResponse.includes('[ACTION:SCHEDULE]')) {
        console.log(`[LOG] [SCHEDULE] Agendamiento solicitado en conversación ${conversationId} con agente ${agentId}`);
        cleanResponse = cleanResponse.replace(/\[ACTION:SCHEDULE\]/g, '').trim();
      }

      if (cleanResponse.includes('[ACTION:REVIEW]')) {
        console.log(`[LOG] [REVIEW] Solicitud de reseña en conversación ${conversationId} con agente ${agentId}`);
        cleanResponse = cleanResponse.replace(/\[ACTION:REVIEW\]/g, '').trim();
      }

      if (cleanResponse.includes('[ACTION:TRACKING]')) {
        console.log(`[LOG] [TRACKING] Seguimiento de lead de alto valor detectado en conversación ${conversationId} con agente ${agentId}`);
        cleanResponse = cleanResponse.replace(/\[ACTION:TRACKING\]/g, '').trim();
      }

      // 7. Enviar la respuesta del bot al usuario final usando el Outbound Router
      await dispatchOutboundMessage({
        recipient: from,
        sender: to,
        body: cleanResponse,
        provider,
        agentConfig: agent,
      });

      // 8. Guardar la respuesta del asistente en Firestore para mantener el historial
      await saveMessage(agentId, conversationId, 'assistant', cleanResponse);

      return { success: true };

    } catch (llmError) {
      console.error('[Message Processor] Gemini API failed:', llmError);
      
      await dispatchOutboundMessage({
        recipient: from,
        sender: to,
        body: 'Disculpá, estoy teniendo problemas técnicos. Intentá de nuevo en un momento.',
        provider,
        agentConfig: agent,
      });
      
      return { success: false, error: 'Gemini API failed' };
    }

  } catch (error: any) {
    console.error('[Message Processor] Fatal error processing message:', error);
    return { success: false, error: error.message || 'Fatal error' };
  }
}
