import { twilioClient } from '@/lib/twilio';

export interface OutboundMessageOptions {
  recipient: string;      // E.164 (ej: +59899123456)
  sender: string;         // E.164 del negocio
  body: string;           // Mensaje a enviar
  provider: 'twilio' | 'meta';
  agentConfig?: any;      // Configuración de conexión del agente para extraer llaves de Meta
}

/**
 * Despacha de forma polimórfica mensajes salientes hacia Twilio o Meta Cloud API.
 */
export async function dispatchOutboundMessage(options: OutboundMessageOptions): Promise<boolean> {
  const { recipient, sender, body, provider, agentConfig } = options;

  console.log(`[Outbound Router] Despachando respuesta vía ${provider} de ${sender} a ${recipient}`);

  try {
    if (provider === 'twilio') {
      // Formatear al estilo Twilio (whatsapp:+...)
      const twilioTo = recipient.startsWith('whatsapp:') ? recipient : `whatsapp:${recipient}`;
      const twilioFrom = sender.startsWith('whatsapp:') ? sender : `whatsapp:${sender}`;

      await twilioClient.messages.create({
        body,
        from: twilioFrom,
        to: twilioTo,
      });
      return true;
    } 
    
    if (provider === 'meta') {
      // Meta requiere que el destinatario sea puramente el número sin prefijos de protocolo
      const cleanRecipient = recipient.replace('whatsapp:', '').replace('+', '').trim();
      const metaConfig = agentConfig?.whatsappConnection?.config?.meta;

      if (!metaConfig || !metaConfig.phoneNumberId || !metaConfig.accessToken) {
        console.error('[Outbound Router] Meta config is missing or incomplete for agent');
        return false;
      }

      const url = `https://graph.facebook.com/v19.0/${metaConfig.phoneNumberId}/messages`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${metaConfig.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanRecipient,
          type: 'text',
          text: {
            preview_url: false,
            body: body,
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('[Outbound Router] Meta Graph API returned error:', errorData);
        return false;
      }

      console.log('[Outbound Router] Mensaje enviado exitosamente vía Meta Graph API');
      return true;
    }

    console.error(`[Outbound Router] Proveedor no soportado: ${provider}`);
    return false;
  } catch (error) {
    console.error(`[Outbound Router] Error al despachar mensaje vía ${provider}:`, error);
    return false;
  }
}
