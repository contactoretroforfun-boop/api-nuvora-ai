import { NextResponse, NextRequest } from 'next/server';
import { verifyFirebaseIdToken } from './lib/auth-edge';

/**
 * Rutas que requieren validación de JWT (privadas del panel)
 */
const PRIVATE_ROUTE_PREFIX = '/api/private';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 1. Aplicar validación SOLAMENTE a rutas privadas
  if (pathname.startsWith(PRIVATE_ROUTE_PREFIX)) {
    // Intentar obtener el token del header Authorization
    let token = '';
    const authHeader = request.headers.get('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    // Si no está en Authorization, buscar en la cookie __session
    if (!token) {
      const sessionCookie = request.cookies.get('__session');
      if (sessionCookie) {
        token = sessionCookie.value;
      }
    }

    // Si no hay token, denegar inmediatamente
    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized: Missing token' },
        { status: 401 }
      );
    }

    // Verificar token criptográficamente
    const { isValid, payload, error } = await verifyFirebaseIdToken(token);

    if (!isValid || !payload) {
      return NextResponse.json(
        { error: `Unauthorized: Invalid token - ${error || 'Signature check failed'}` },
        { status: 401 }
      );
    }

    // Inyectar claims verificadas en los headers para que la ruta las consuma de forma segura
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-user-uid', payload.uid);
    requestHeaders.set('x-user-email', payload.email || '');
    requestHeaders.set('x-user-role', payload.role || '');

    return NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
  }

  // Rutas públicas y Webhooks de Twilio / Meta pasan directo sin autenticación JWT
  return NextResponse.next();
}

// Configurar los matchers para optimizar la ejecución del middleware
export const config = {
  matcher: ['/api/private/:path*', '/api/webhook/:path*'],
};
