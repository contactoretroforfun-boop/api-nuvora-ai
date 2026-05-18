import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';
import { processIncomingMessage } from '@/services/messageProcessor';

/**
 * Webhook de Entrada de Twilio WhatsApp.
 * Valida de forma estricta y criptográfica la firma del remitente (X-Twilio-Signature).
 */
export async function POST(req: NextRequest) {
  try {
    const text = await req.text();
    const params = new URLSearchParams(text);

    // Convertir parámetros de Twilio a un objeto plano
    const twilioParams: { [key: string]: string } = {};
    params.forEach((value, key) => {
      twilioParams[key] = value;
    });

    const from = twilioParams['From'] || '';
    const to = twilioParams['To'] || '';
    const body = twilioParams['Body'] || '';
    const messageSid = twilioParams['MessageSid'] || '';

    // 1. Hardening: Reconstrucción de la URL detrás de Vercel Proxy / Cloudflare
    const proto = req.headers.get('x-forwarded-proto') || 'https';
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'api.nuvora.agency';
    const pathname = req.nextUrl.pathname;
    const webhookUrl = `${proto}://${host}${pathname}`;

    const signature = req.headers.get('x-twilio-signature') || '';
    const authToken = process.env.TWILIO_AUTH_TOKEN || '';

    // 2. Validación de Firma criptográfica de Twilio
    // Nota: Omitir en localhost para facilitar pruebas si no se envía firma,
    // pero requerir estrictamente en producción.
    const isProduction = process.env.NODE_ENV === 'production';
    
    if (isProduction || signature) {
      const isValid = twilio.validateRequest(
        authToken,
        signature,
        webhookUrl,
        twilioParams
      );

      if (!isValid) {
        console.error('[Twilio Webhook] Firma de Twilio inválida. Denegado.');
        return new NextResponse('Forbidden: Invalid Twilio Signature', { status: 403 });
      }
    }

    if (!from || !to || !body) {
      console.warn('[Twilio Webhook] Petición válida pero faltan parámetros esenciales.');
      return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
    }

    // 3. Normalizar a UnifiedIncomingMessage
    const unifiedMessage = {
      messageId: messageSid,
      from,
      to,
      body,
      provider: 'twilio' as const,
      rawPayload: twilioParams,
    };

    // 4. Delegar procesamiento al Core Agnóstico
    const result = await processIncomingMessage(unifiedMessage);

    if (!result.success) {
      console.warn(`[Twilio Webhook] Error al procesar mensaje: ${result.error}`);
    }

    // Retornar siempre un 200 OK con TwiML vacío (o json success) para Twilio
    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('[Twilio Webhook] Error fatal en Webhook:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
