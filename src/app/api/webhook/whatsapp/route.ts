import { NextRequest, NextResponse } from 'next/server';
import { POST as twilioPOST } from './twilio/route';

/**
 * Endpoint de compatibilidad hacia atrás para la ruta original de WhatsApp.
 * Redirige y delega la ejecución al webhook de Twilio con validación estricta de firma.
 */
export async function POST(req: NextRequest) {
  console.log('[Compatibility Route] Delegando petición entrante al Webhook de Twilio...');
  return twilioPOST(req);
}
