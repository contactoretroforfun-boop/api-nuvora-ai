# Contexto de Backend y Base de Datos (Nuvora Control Panel)

Este documento detalla la estructura actual de datos y configuraciones en Firebase (Firestore & Storage) para el proyecto *Nuvora Control Panel*. Está diseñado como referencia técnica estricta para el backend externo (Node.js/Python) que procesa los agentes, interactúa con Twilio (WhatsApp) y Gemini.

**Nota importante:** Se ha eliminado por completo cualquier dependencia o referencia a 360dialog y Claude API. El flujo es 100% Twilio + Gemini.

## 1. Estructura de Colecciones en Firestore

El proyecto utiliza una base de datos NoSQL jerárquica con la siguiente estructura principal:

```text
/clients (Collection - CRM)
  └── /{clientId} (Document)
/agents (Collection)
  ├── /{agentId} (Document)
  │     └── /conversations (Sub-Collection)
  │           └── /{conversationId} (Document)
  └── /{agentId} (Document)
```

## 2. Esquema del Documento: `/agents/{agentId}`

Cada agente configurado a través del Wizard genera un documento principal. El ID del documento (`agentId`) se genera automáticamente.

**Ejemplo de Payload:**
```json
{
  "id": "agt_xyz123",
  "status": "published", // "draft", "published"
  "name": "Nombre del Negocio",
  "client": "Nombre del Negocio",
  "currentStep": 10,
  "updatedAt": 1715893200000,
  
  // CONFIGURACIÓN DEL AGENTE (Prompts, Horarios, etc.)
  "data": {
    "businessName": "Estética Lumina",
    "industry": "Centro de Estética",
    "location": "Pocitos, Montevideo",
    "tone": "Cercano",
    "schedule": [...],
    "modules": { ... }
  },

  // CONFIGURACIÓN DE DEPLOYMENT MULTI-PROVIDER (ACTUALIZADO)
  "sandboxConnection": {
    "provider": "twilio",
    "mode": "sandbox",
    "active": true,
    "connectedAt": 1715893200000
  },
  
  "whatsappConnection": {
    "provider": "twilio", // "twilio" | "meta"
    "mode": "production",
    "phoneNumber": "+59899123456", // E.164 sanitizado e indexado
    "status": "pending", // "pending", "active", "error"
    "config": {
      "twilio": {
        "notes": "Configuración interna o logs del webhook"
      },
      "meta": {
        "phoneNumberId": "10294827104928",
        "businessAccountId": "8374829384729",
        "accessToken": "EAAG..."
      }
    },
    "connectedAt": 1715893200000
  }
}
```

## 3. Subcolección: `/agents/{agentId}/conversations`

El backend gestiona el registro de los mensajes entrantes y salientes de Twilio para alimentar el Dashboard de Historial del panel.

**Estructura esperada por el Frontend:**
```json
{
  "conversationId": "conv_987654",
  "contactNumber": "+59899123456",
  "contactName": "Juan Pérez",
  "status": "active", // "active", "resolved", "handed_off"
  "lastMessageAt": 1715893205000,
  "history": [
    {
      "role": "user",
      "content": "Hola, quería agendar un turno",
      "timestamp": 1715893200000
    },
    {
      "role": "assistant",
      "content": "¡Hola Juan! Claro, ¿para qué servicio te gustaría?",
      "timestamp": 1715893205000
    }
  ]
}
```

## 4. Lógica de Enrutamiento en el Backend (Twilio -> Agente)

Con la nueva actualización del Paso 10 del Wizard, existen dos flujos de conexión:

### A) Testing con Sandbox Interno
Cuando llega un Webhook a `https://api.nuvora.agency/api/webhook/whatsapp` desde el número oficial de Twilio Sandbox (`+1 415 523 8886`), el backend debe:
1. Buscar en Firestore el agente que tenga `sandboxConnection.active == true`.
2. Usar ESE agente (su prompt, reglas y conocimiento reales de Gemini) para responderle al usuario.
3. Esto permite al equipo interno probar al 100% el agente antes de conectarle un número real.

### B) Producción con Número Real
Cuando el cliente brinda su número, se registra en `whatsappConnection.phoneNumber`. 
El backend recibe el Webhook desde ese número de producción (ej. `+598 99...`) y debe:
1. Buscar en Firestore el agente donde `whatsappConnection.phoneNumber` coincida con el destinatario (`To`).
2. Operar el agente de forma normal.

## 5. Colección: `/clients/{clientId}` (NUEVO CRM)

El área de Clientes almacena a las empresas que pagan la mensualidad de Nuvora.

```json
{
  "id": "cli_xyz",
  "name": "Estética Lumina",
  "contact": "María Fernández",
  "email": "correo@estetica.com",
  "phone": "+59899123456",
  "nextPayment": "2026-06-10",
  "status": "activo", // "activo", "suspendido"
  "createdAt": 1715893200000
}
```

## 6. Variables y Configuraciones de Firebase

**Variables inyectadas (`.env.local`):**
```env
NEXT_PUBLIC_FIREBASE_API_KEY="..."
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="..."
NEXT_PUBLIC_FIREBASE_PROJECT_ID="..."
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET="..."
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID="..."
NEXT_PUBLIC_FIREBASE_APP_ID="..."
```

## 7. Transición de Estado de Publicación

- Cuando el usuario finaliza el Wizard en el Control Panel y hace clic en "Publicar Agente", el campo `status` del agente pasará a `"published"`.
- El Backend debe estar preparado para escuchar (mediante listeners o validando dinámicamente) estos cambios de estado para saber qué agentes están aptos para responder en producción.

## 8. Arquitectura Desacoplada (Multi-Provider WhatsApp)

Para evitar dependencias directas con Twilio y permitir soportar Meta Cloud API en el futuro de forma transparente, el backend debe estructurarse con la siguiente jerarquía de responsabilidades:

1. **Webhooks de Entrada Específicos:**
   - `/api/webhook/whatsapp/twilio`: Parsea el payload URLencoded de Twilio, valida la firma de seguridad `X-Twilio-Signature` y normaliza el mensaje entrante.
   - `/api/webhook/whatsapp/meta`: Parsea el JSON estructurado de Meta, responde al protocolo de verificación (`hub.challenge`) en GET, valida la firma HMAC-SHA256, y normaliza el mensaje.
   
2. **Payloads Internos Unificados:**
   ```typescript
   export interface UnifiedIncomingMessage {
     messageId: string;
     from: string;      // E.164 sanitizado (ej: +59899123456)
     to: string;        // E.164 destinatario
     body: string;
     provider: "twilio" | "meta";
     rawPayload: any;
   }
   ```

3. **Core de Procesamiento Agnóstico (`messageProcessor.ts`):**
   Recibe el `UnifiedIncomingMessage`. Realiza de manera secuencial e independiente del proveedor:
   - Consulta Firestore por `to` (coincidiendo con `whatsappConnection.phoneNumber`).
   - Obtiene el historial de la subcolección `/conversations`.
   - Llama a Gemini API pasándole las directivas del agente.
   - Procesa y filtra etiquetas internas (como acciones de Handoff).
   - Registra el mensaje en Firestore.
   - Delega la respuesta saliente al **Router de Despacho (Outbound Router)**.

4. **Router de Despacho Saliente:**
   Despacha la respuesta al cliente final de forma polimórfica:
   - Si `provider === "twilio"`: Llama al cliente Twilio SDK usando `whatsappConnection.config.twilio`.
   - Si `provider === "meta"`: Ejecuta una petición HTTP POST a la Graph API de Facebook usando `whatsappConnection.config.meta`.

## 9. Seguridad y Validación de Firmas (Hardening Webhooks)

Es obligatorio habilitar la validación de peticiones en los endpoints expuestos en producción:

### A) Validación para Twilio:
El endpoint `/api/webhook/whatsapp/twilio` debe verificar que el request provenga de Twilio comparando el header `X-Twilio-Signature` usando el helper oficial del SDK:
```typescript
import twilio from "twilio";

const signature = req.headers.get("x-twilio-signature") || "";
const isValid = twilio.validateRequest(
  process.env.TWILIO_AUTH_TOKEN!,
  signature,
  webhookUrl, // Reconstruida a partir de headers de proxy (x-forwarded-proto/host)
  payloadObject
);
```

### B) Validación para Meta:
El endpoint `/api/webhook/whatsapp/meta` debe:
1. Responder síncronamente en GET verificando el token secreto (`hub.verify_token`) y retornando el `hub.challenge`.
2. Validar la firma HMAC-SHA256 en cada POST usando el header `X-Hub-Signature-256` y la clave secreta de la aplicación de Meta.

## 10. Validación y Sincronización de Autenticación (Edge Token Verification & Claims)

Para el hardening completo de las rutas del panel y protección de cualquier endpoint REST privado en el backend externo, se han implementado las siguientes directivas de sincronización:

### A) Escucha y Auto-Renovación de Tokens en el Cliente:
El frontend migró de `onAuthStateChanged` a **`onIdTokenChanged`**. 
- **Efecto:** Cada vez que Firebase refresca automáticamente el token interno (cada 55-60 min), la cookie `__session` del navegador se actualiza instantáneamente con el nuevo JWT válido. Esto previene desincronizaciones de sesión y hydration mismatches.

### B) Resolución de Roles Híbridos (RBAC):
El rol del usuario se resuelve de forma jerárquica:
1. **Custom Claims (Rápido y Seguro):** Decodifica las claims personalizadas del JWT (`tokenResult.claims.role`).
2. **Firestore Fallback:** Si no existen Claims aún en la sesión, consulta la colección `/users/{uid}` para obtener el rol, cayendo en `"team"` por defecto.

### C) Verificación Criptográfica del ID Token en Next.js / Vercel Edge:
Cualquier endpoint privado de la API externa que consuma la cookie `__session` o un header `Authorization: Bearer <token>` **debe validar criptográficamente la autenticidad de la firma** sin depender de Firebase Admin (el cual no corre en entornos Edge). 

Se utiliza la librería `jose` para validar contra el conjunto de claves públicas JWKS de Google:
```typescript
import * as jose from "jose";

const JWKS = jose.createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);

const PROJECT_ID = "nuvora-control-panel"; // Tu id de proyecto Firebase
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;

export async function verifyFirebaseIdToken(token: string) {
  try {
    const { payload } = await jose.jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: PROJECT_ID,
    });
    return { isValid: true, payload };
  } catch (err) {
    console.error("JWT Verification failed:", err);
    return { isValid: false };
  }
}
```
Si la validación es correcta, las Claims del usuario (incluyendo su `uid` y `role` asignado) se extraen directamente de la firma del payload con confianza absoluta del 100%.


