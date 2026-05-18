import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { processIncomingMessage } from '@/services/messageProcessor';

/**
 * GET - Verificación del Webhook por parte de Facebook Graph API (Meta).
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const mode = searchParams.get('hub.mode');
    const token = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');

    const verifyToken = process.env.META_VERIFY_TOKEN || 'nuvora_meta_secret_token';

    if (mode === 'subscribe' && token === verifyToken) {
      console.log('[Meta Webhook] Webhook verificado correctamente por Facebook.');
      return new NextResponse(challenge, { status: 200 });
    }

    console.warn('[Meta Webhook] Token de verificación fallido o incorrecto.');
    return new NextResponse('Forbidden', { status: 403 });
  } catch (error) {
    console.error('[Meta Webhook] Error en verificación GET:', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}

/**
 * POST - Recepción y procesamiento de mensajes de Meta Cloud API.
 * Valida la firma criptográfica HMAC-SHA256 (X-Hub-Signature-256).
 */
export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signatureHeader = req.headers.get('x-hub-signature-256') || '';

    const appSecret = process.env.META_APP_SECRET || '';

    // 1. Hardening: Validar la firma HMAC-SHA256
    const isProduction = process.env.NODE_ENV === 'production';
    
    if ((isProduction || signatureHeader) && appSecret) {
      const signature = signatureHeader.startsWith('sha256=')
        ? signatureHeader.substring(7)
        : signatureHeader;

      const computedSignature = crypto
        .createHmac('sha256', appSecret)
        .update(rawBody)
        .digest('hex');

      if (computedSignature !== signature) {
        console.error('[Meta Webhook] Firma HMAC-SHA256 inválida. Acceso denegado.');
        return new NextResponse('Forbidden: Invalid Signature', { status: 403 });
      }
    }

    // 2. Parsear el body JSON
    const payload = JSON.parse(rawBody);

    // Verificar si es una notificación de mensaje válida
    if (payload.object !== 'whatsapp_business_account') {
      return NextResponse.json({ error: 'Unsupported object type' }, { status: 400 });
    }

    const entry = payload.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Si es un estado de entrega (delivery status, sent, read), ignorar para evitar doble procesamiento
    if (!value || !value.messages || value.messages.length === 0) {
      return NextResponse.json({ success: true, message: 'Status notification ignored' });
    }

    const message = value.messages[0];
    
    // Ignorar si el tipo no es texto
    if (message.type !== 'text') {
      console.log(`[Meta Webhook] Tipo de mensaje no soportado (${message.type}). Ignorado.`);
      return NextResponse.json({ success: true, message: 'Non-text message ignored' });
    }

    // Estructurar campos E.164 limpios
    const from = `+${message.from}`; // wa_id o from del usuario
    const to = `+${value.metadata?.display_phone_number}`; // Teléfono visible del negocio
    const body = message.text?.body || '';
    const messageId = message.id || '';

    if (!from || !to || !body) {
      return NextResponse.json({ error: 'Missing parameters in structured payload' }, { status: 400 });
    }

    // 3. Normalizar a UnifiedIncomingMessage
    const unifiedMessage = {
      messageId,
      from,
      to,
      body,
      provider: 'meta' as const,
      rawPayload: payload,
    };

    // 4. Procesar el mensaje con el procesador agnóstico
    const result = await processIncomingMessage(unifiedMessage);

    if (!result.success) {
      console.warn(`[Meta Webhook] Error procesando mensaje de Meta: ${result.error}`);
    }

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('[Meta Webhook] Error fatal procesando webhook:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
