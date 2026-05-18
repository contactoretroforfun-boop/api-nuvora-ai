import * as jose from 'jose';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const JWKS = jose.createRemoteJWKSet(new URL(JWKS_URL));

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'nuvora-control-panel';
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;

export interface DecodedIdToken {
  uid: string;
  email?: string;
  role?: 'admin' | 'team' | 'training';
  [key: string]: any;
}

/**
 * Verifica criptográficamente un Firebase ID Token (JWT) usando jose y JWKS de Google.
 * Totalmente compatible con entornos Edge/Vercel Middleware.
 */
export async function verifyFirebaseIdToken(token: string): Promise<{ isValid: boolean; payload?: DecodedIdToken; error?: string }> {
  try {
    if (!token) {
      return { isValid: false, error: 'Token is empty' };
    }

    const { payload } = await jose.jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: PROJECT_ID,
    });

    // Firebase UID se guarda en 'sub'
    const uid = payload.sub as string;
    const email = payload.email as string | undefined;
    const role = payload.role as 'admin' | 'team' | 'training' | undefined;

    return {
      isValid: true,
      payload: {
        ...payload,
        uid,
        email,
        role,
      },
    };
  } catch (error: any) {
    console.error('JWT Verification failed:', error.message || error);
    return { isValid: false, error: error.message || 'Verification failed' };
  }
}

/**
 * Resuelve jerárquicamente el rol del usuario:
 * 1. Desde las Custom Claims del Token (si existen).
 * 2. Fallback dinámico a Firestore (/users/{uid}) si no están en claims.
 * Nota: El fallback a Firestore no funcionará en entornos Edge debido a la dependencia de firebase-admin.
 */
export async function resolveUserRole(uid: string, tokenClaimsRole?: 'admin' | 'team' | 'training'): Promise<'admin' | 'team' | 'training'> {
  if (tokenClaimsRole) {
    return tokenClaimsRole;
  }

  try {
    // Importación dinámica de firebase-admin para no romper compilaciones en Edge
    const { getDb } = await import('@/lib/firebase-admin');
    const db = getDb();
    
    const userDoc = await db.collection('users').doc(uid).get();
    if (userDoc.exists) {
      const data = userDoc.data();
      if (data && (data.role === 'admin' || data.role === 'team' || data.role === 'training')) {
        return data.role;
      }
    }
  } catch (error) {
    console.warn('Firestore fallback role resolution failed (likely running in Edge environment):', error);
  }

  // Rol por defecto según requerimiento
  return 'team';
}
