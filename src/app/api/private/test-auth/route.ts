import { NextRequest, NextResponse } from 'next/server';
import { resolveUserRole } from '@/lib/auth';

/**
 * GET /api/private/test-auth
 * Endpoint protegido para validar que el middleware inyecta correctamente el contexto de usuario 
 * y que resolveUserRole determina el rol del usuario (Claims -> Firestore fallback).
 */
export async function GET(req: NextRequest) {
  try {
    const uid = req.headers.get('x-user-uid');
    const email = req.headers.get('x-user-email');
    const tokenRole = req.headers.get('x-user-role') || undefined;

    if (!uid) {
      return NextResponse.json(
        { error: 'Unauthorized: Missing verified user headers' },
        { status: 401 }
      );
    }

    // Resolver rol jerárquicamente (Claims o Fallback a Firestore)
    const role = await resolveUserRole(uid, tokenRole as any);

    return NextResponse.json({
      success: true,
      message: 'Token criptográfico verificado con éxito y sesión válida.',
      auth: {
        uid,
        email,
        claimsRole: tokenRole || 'Ninguno',
        resolvedRole: role,
      },
      rbac: {
        isAdmin: role === 'admin',
        isTeam: role === 'team',
        isTraining: role === 'training',
      }
    });

  } catch (error: any) {
    console.error('[Test Auth API] Error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error.message },
      { status: 500 }
    );
  }
}
