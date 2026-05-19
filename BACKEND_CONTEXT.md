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

---

## 11. AI Business Operating System (AI OS) Schema Additions & Prompt Compiler Refactor

Con la evolución del Wizard hacia un "AI Business Operating System", se han incorporado campos y motores lógicos avanzados al objeto `data` en Firestore dentro del documento `/agents/{agentId}`.

### A) Nuevas Estructuras de Datos en Firestore (`data`)

Las siguientes propiedades se guardan ahora de forma síncrona desde el Frontend:

```json
{
  "data": {
    // ... campos básicos anteriores (businessName, industry, location, schedule, tone) ...

    // 1. PERSONALIDAD DINÁMICA SEGÚN CONTEXTO (Step 2)
    "dynamicPersonality": {
      "ventas": { "style": "persuasivo", "instruction": "Enfócate en beneficios, escasez y llamado al cierre." },
      "soporte": { "style": "explicativo", "instruction": "Sé paciente, claro y usa listas viñeteadas." },
      "reclamo": { "style": "calmado", "instruction": "Valida sentimientos, discúlapate y ofrece derivar." },
      "followUp": { "style": "motivacional", "instruction": "Recuerda el valor del servicio de forma amigable." }
    },

    // 2. MOTOR DE INTENCIONES (Step 4)
    "intentEngine": [
      {
        "name": "consulta_precio",
        "triggers": "precio, costo, cotizar, cuanto sale",
        "action": "pedir_datos", // "responder_directo" | "intentar_cierre" | "derivar_humano" | "pedir_datos"
        "priority": "alta"       // "baja" | "media" | "alta"
      }
    ],

    // 3. MOTOR DE DECISIONES SIMPLE (Step 4)
    "ruleEngine": [
      {
        "ifCondition": "usuario nuevo + pide precio",
        "thenAction": "cta_whatsapp" // "respuesta_especifica" | "cta_whatsapp" | "derivacion"
      }
    ],

    // 4. CONTROL DE ESTILO DE VENTA (Step 4)
    "salesStyle": {
      "pressure": "medio",     // "bajo" | "medio" | "alto"
      "proactivity": "guiado",  // "reactivo" | "guiado" | "agresivo"
      "style": "consultivo"     // "consultivo" | "vendedor" | "asistente"
    },

    // 5. MÓDULOS AVANZADOS ACTIVOS (Step 8)
    "activeModules": {
      "agendamiento": true,
      "seguimiento": true,
      "resenas": false,
      "aprendizaje": true,
      "objeciones": true,
      "segmentacion": true,
      "horarios": true
    },

    // 6. MANEJO DE OBJECIONES (Step 8)
    "objecionesConfig": {
      "objections": [
        {
          "trigger": "es caro",
          "reply": "Entiendo tu preocupación, sin embargo nuestro servicio cuenta con garantía...",
          "style": "persuasivo",
          "action": "ofrecer_alternativa"
        }
      ]
    },

    // 7. SEGMENTACIÓN & CRM LIGHT (Step 8)
    "segmentacionConfig": {
      "segments": {
        "nuevo": { "style": "calido", "strategy": "Educación y presentación de la marca." },
        "alto_valor": { "style": "exclusivo", "strategy": "Beneficios VIP inmediatos." },
        "indeciso": { "style": "persuasivo", "strategy": "Testimonios y flexibilidades." },
        "en_riesgo": { "style": "empatico", "strategy": "Ofrecer descuento de retención." }
      },
      "crmAutomaticTagging": true
    },

    // 8. HORARIOS INTELIGENTES (Step 8)
    "horariosConfig": {
      "conversionHours": "18:00 a 21:00",
      "contactRule": "ofrecer_turno_inmediato" // "ofrecer_turno_inmediato" | "calificar_primero" | "enviar_link"
    },

    // 9. CAPTURA DE RESEÑAS DETALLADA (Step 8)
    "resenasConfig": {
      "delayValue": 2,
      "delayUnit": "Semanas",
      "allowedHoursStart": "10:00",
      "allowedHoursEnd": "20:00",
      "sondeoMessage": "¡Hola {{nombre}}! ¿Qué tal te resultó el servicio de {{servicio}} de hoy?",
      "useSecondarySondeo": false,
      "secondarySondeoMessage": "Entiendo. Nos ayuda mucho saber tu opinión sincera, ¿hubo algo que podríamos haber hecho mejor?",
      "satisfactionThreshold": 70,
      "reviewMessage": "¡Qué alegría {{nombre}}! Nos ayuda un montón si nos dejás unas estrellitas acá, lleva solo 10 segundos:",
      "googleReviewsUrl": "https://g.page/r/...",
      "alternativeUrl": "",
      "resendReview": false,
      "resendReviewDelay": 24,
      "disconformeAction": "Ambas",
      "ownerWhatsapp": "",
      "empathyMessage": "Uy, mil disculpas {{nombre}}. Ya mismo le paso este comentario a los encargados...",
      "notificationFields": ["Nombre del cliente", "Servicio", "Fecha", "Resumen de la queja", "Acción sugerida"],
      "maxRequests": 3,
      "minDays": 60,
      "neverAskAgain": true
    }
  }
}
```

### B) Lógica de Procesamiento en Backend (`messageProcessor.ts` & Gemini Compiler)

Para soportar este comportamiento jerárquico de forma 100% robusta en el backend externo en Vercel, el compilador del System Prompt del agente debe implementarse de manera estructurada en **9 Niveles de Prioridad** (evitando conflictos y alucinaciones):

1. **Nivel 1 (Hard Rules):** Reglas absolutas e inviolables de comportamiento, etiquetas ocultas de derivación (`[ACTION:HANDOFF]`), y restricciones de WhatsApp.
2. **Nivel 2 (Contexto del Negocio):** Nombre comercial, industria, catálogo de productos/servicios y horarios de atención estándar.
3. **Nivel 3 (Psicología Dinámica & Sales Controller):** Tono general, instrucciones personalizadas de tono y el objeto `dynamicPersonality` mapeando la respuesta del bot al contexto detectado. Inyección del estilo de ventas (`pressure`, `proactivity`, `style`).
4. **Nivel 4 (Intent Engine):** Mapeo de intenciones para que la IA clasifique las keywords del usuario en caliente y gatille los flujos estructurados de acción (`action`, `priority`).
5. **Nivel 5 (Decision Rule Engine):** Reglas condicionales IF/THEN de negocio (ej. usuarios nuevos versus recurrentes).
6. **Nivel 6 (Objections Engine):** Argumentos comerciales estructurados. Si el usuario objeta el precio o tiempo, el bot inyecta la contra-respuesta persuasiva pre-definida.
7. **Nivel 7 (CRM & Client Segmentations):** Estrategias de conversión según la clasificación del contacto.
8. **Nivel 8 (Horarios Inteligentes):** Variación de la proactividad según el rango de conversión de la hora de recepción.
9. **Nivel 9 (APIs & Actions):** Integración de enlaces dinámicos de agenda (Cal.com) y reseñas de Google Maps.

### C) Sincronización del CRM Light del Cliente (`/conversations`)

Cuando el `messageProcessor.ts` interactúa con el cliente final por WhatsApp, debe actualizar automáticamente el estado y las etiquetas del cliente dentro de su documento de conversación en Firestore:
* **`status`:** `"active"` | `"resolved"` | `"handed_off"`.
* **`tags` (Automáticos):** Si el mensaje del usuario gatilló una intención (ej: `consulta_precio`), el backend debe agregar el tag `"pidio_precio"` o `"interesado_en_servicio"` al array de tags del contacto en Firestore para alimentar el mini-CRM del panel.
