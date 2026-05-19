import { getAgentByWhatsApp, getConversationHistory, saveMessage, updateConversationCRM } from '@/services/agentService';
import { buildSystemPrompt } from '@/services/promptBuilder';
import { gemini } from '@/lib/gemini';
import { dispatchOutboundMessage } from '@/services/outboundRouter';
import { getDb } from '@/lib/firebase-admin';

export interface UnifiedIncomingMessage {
  messageId: string;
  from: string;      // E.164 sanitizado (ej: +59899123456)
  to: string;        // E.164 destinatario (ej: +14155238886)
  body: string;
  provider: 'twilio' | 'meta';
  rawPayload: any;
}

/**
 * Reemplaza de forma segura los placeholders {{nombre}} y {{servicio}} en las plantillas.
 */
function formatMessageTemplate(template: string, name: string, service: string = 'nuestro servicio'): string {
  if (!template) return '';
  return template
    .replace(/\{\{nombre\}\}/g, name || 'estimado/a')
    .replace(/\{\{servicio\}\}/g, service || 'nuestro servicio');
}

/**
 * Core de procesamiento agnóstico de proveedor para Nuvora AI.
 * Ejecuta el pipeline cognitivo completo (Gemini + CRM Light + Reviews Engine + Actions).
 */
export async function processIncomingMessage(incoming: UnifiedIncomingMessage): Promise<{ success: boolean; error?: string }> {
  const { from, to, body, provider } = incoming;

  try {
    // 1. Sanitización de números
    const cleanToNumber = to.replace('whatsapp:', '').trim();
    const cleanFromNumber = from.replace('whatsapp:', '').trim();

    // 2. Encontrar agente en Firestore
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

    // 3. Validación de status published (excepto Sandbox test)
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

    // 4. Resolver nombre del cliente desde el payload de WhatsApp (CRM Feed)
    let contactName = 'estimado/a';
    if (provider === 'twilio') {
      contactName = incoming.rawPayload?.ProfileName || 'estimado/a';
    } else if (provider === 'meta') {
      contactName = incoming.rawPayload?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || 'estimado/a';
    }

    // 5. CRM Light: Motor de Intenciones Estático (Intent Trigger Matching)
    const detectedTags: string[] = [];
    let conversationStatus: 'active' | 'resolved' | 'handed_off' = 'active';

    if (agent.data?.intentEngine && Array.isArray(agent.data.intentEngine)) {
      const userBodyLower = body.toLowerCase();
      agent.data.intentEngine.forEach((intent: any) => {
        const triggers = intent.triggers?.split(',').map((t: string) => t.trim().toLowerCase()) || [];
        const matched = triggers.some((trigger: string) => trigger && userBodyLower.includes(trigger));
        if (matched) {
          detectedTags.push(intent.name);
          // Conversión a tags estándar del CRM de Nuvora Panel
          if (intent.name.includes('precio') || intent.name.includes('costo') || intent.name.includes('cotizar')) {
            detectedTags.push('pidio_precio');
          }
          if (intent.name.includes('turno') || intent.name.includes('agenda') || intent.name.includes('reserva')) {
            detectedTags.push('solicito_turno');
          }
        }
      });
    }

    // 6. Recuperar historial (últimos 10 mensajes)
    const history = await getConversationHistory(agentId, conversationId);

    // 7. Guardar mensaje entrante
    await saveMessage(agentId, conversationId, 'user', body);

    // 8. Preparar Prompt y Llamar a Gemini API
    const systemPrompt = buildSystemPrompt(agent.data);

    const geminiMessages = history.map((msg: any) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

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

      // 9. CRM Light: Extraer etiquetas silenciosas de Gemini [TAG:XYZ]
      const tagMatches = cleanResponse.match(/\[TAG:([A-Za-z0-9_]+)\]/g);
      if (tagMatches) {
        tagMatches.forEach((tagMatch) => {
          const tag = tagMatch.replace('[TAG:', '').replace(']', '').toLowerCase();
          detectedTags.push(tag);
        });
      }

      // 10. Procesamiento de Acciones y Módulos Avanzados (Handoff, Reviews, etc.)
      
      // Handoff (Derivación)
      const hasHandoff = cleanResponse.includes('[ACTION:HANDOFF]');
      if (hasHandoff) {
        conversationStatus = 'handed_off';
        detectedTags.push('derivado_a_humano');
        
        const handoffNumber = agent.data?.desvioEquipo?.responsable || agent.data?.modules?.scheduling?.notificationNumber;
        if (handoffNumber) {
          const summary = `🚨 *DERIVACIÓN SOLICITADA* 🚨\n\n*Cliente:* ${contactName} (${cleanFromNumber})\n*Mensaje:* "${body}"`;
          
          await dispatchOutboundMessage({
            recipient: handoffNumber,
            sender: to,
            body: summary,
            provider,
            agentConfig: agent,
          });
        }
      }

      // Módulo de Agendamiento
      if (cleanResponse.includes('[ACTION:SCHEDULE]')) {
        console.log(`[LOG] [SCHEDULE] Agendamiento gatillado para el cliente ${cleanFromNumber}`);
        detectedTags.push('interesado_agendar');
      }

      // Módulo de Seguimiento (Tracking)
      if (cleanResponse.includes('[ACTION:TRACKING]')) {
        console.log(`[LOG] [TRACKING] Seguimiento de lead de alto valor para ${cleanFromNumber}`);
        detectedTags.push('lead_alto_valor');
      }

      // 11. REVIEWS ENGINE (Mapeo de Flujo de Reseñas de Google & Sondeo de Satisfacción)
      let reviewStateUpdate: 'sondeo_sent' | 'completed' | 'complaint_registered' | undefined;
      const resenasConfig = agent.data?.resenasConfig;
      
      if (agent.data?.activeModules?.resenas && resenasConfig) {
        const { googleReviewsUrl, sondeoMessage, reviewMessage, empathyMessage, ownerWhatsapp } = resenasConfig;
        
        // A) Inicio de Sondeo de Satisfacción
        if (cleanResponse.includes('[ACTION:START_SONDEO]')) {
          const serviceName = agent.data?.services?.[0]?.name || 'nuestro servicio';
          cleanResponse = formatMessageTemplate(sondeoMessage, contactName, serviceName);
          reviewStateUpdate = 'sondeo_sent';
          detectedTags.push('sondeo_satisfaccion_enviado');
        } 
        
        // B) Respuesta Favorable (Despacho del link de Google Reviews)
        else if (cleanResponse.includes('[ACTION:REVIEW_FAVORABLE]') || cleanResponse.includes('[ACTION:REVIEW]')) {
          const formattedReviewMsg = formatMessageTemplate(reviewMessage, contactName);
          cleanResponse = `${formattedReviewMsg}\n\n${googleReviewsUrl || ''}`.trim();
          reviewStateUpdate = 'completed';
          detectedTags.push('reseña_favorable');
        } 
        
        // C) Respuesta Desfavorable (Mensaje de empatía, Guardado de Queja y Notificación Admin)
        else if (cleanResponse.includes('[ACTION:REVIEW_UNFAVORABLE]')) {
          const formattedEmpathy = formatMessageTemplate(empathyMessage, contactName);
          cleanResponse = formattedEmpathy;
          reviewStateUpdate = 'complaint_registered';
          detectedTags.push('queja_registrada');

          // 1. Guardar la queja en Firestore para visibilidad CRM
          try {
            const db = getDb();
            await db.collection('agents').doc(agentId).collection('complaints').add({
              customerNumber: cleanFromNumber,
              customerName: contactName,
              complaintText: body,
              empathyMessageSent: formattedEmpathy,
              timestamp: Date.now()
            });
            console.log(`[Reviews Engine] Queja guardada con éxito en Firestore para agente ${agentId}`);
          } catch (dbErr) {
            console.error('[Reviews Engine] Error guardando queja en DB:', dbErr);
          }

          // 2. Notificar al dueño por WhatsApp
          if (ownerWhatsapp) {
            const cleanOwnerNum = ownerWhatsapp.replace('whatsapp:', '').trim();
            const alertBody = `🚨 *ALERTA DE QUEJA EN NUVORA AI* 🚨\n\n*Cliente:* ${contactName} (${cleanFromNumber})\n*Queja:* "${body}"\n*Respuesta de empatía enviada:* "${formattedEmpathy}"`;
            
            await dispatchOutboundMessage({
              recipient: cleanOwnerNum,
              sender: to,
              body: alertBody,
              provider,
              agentConfig: agent,
            });
          }
        }
      }

      // 12. Hardening de Formatos: Limpiar etiquetas del mensaje final de WhatsApp
      cleanResponse = cleanResponse
        .replace(/\[ACTION:HANDOFF\]/g, '')
        .replace(/\[ACTION:SCHEDULE\]/g, '')
        .replace(/\[ACTION:REVIEW\]/g, '')
        .replace(/\[ACTION:REVIEW_FAVORABLE\]/g, '')
        .replace(/\[ACTION:REVIEW_UNFAVORABLE\]/g, '')
        .replace(/\[ACTION:START_SONDEO\]/g, '')
        .replace(/\[ACTION:TRACKING\]/g, '')
        .replace(/\[TAG:[A-Za-z0-9_]+\]/g, '')
        .trim();

      // 13. Enviar la respuesta procesada al usuario final
      await dispatchOutboundMessage({
        recipient: from,
        sender: to,
        body: cleanResponse,
        provider,
        agentConfig: agent,
      });

      // 14. Guardar respuesta del bot en el historial de mensajes
      await saveMessage(agentId, conversationId, 'assistant', cleanResponse);

      // 15. Actualizar transaccionalmente el CRM de la conversación (Tags, Status, Nombre, ReviewState)
      await updateConversationCRM(agentId, conversationId, {
        tags: detectedTags,
        status: conversationStatus,
        contactName: contactName !== 'estimado/a' ? contactName : undefined,
        reviewState: reviewStateUpdate,
      });

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
