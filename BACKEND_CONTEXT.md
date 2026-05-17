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

  // CONFIGURACIÓN DE DEPLOYMENT Y TWILIO (NUEVO)
  "sandboxConnection": {
    "provider": "twilio",
    "mode": "sandbox",
    "active": true,
    "connectedAt": 1715893200000
  },
  
  "whatsappConnection": {
    "provider": "twilio",
    "mode": "production",
    "phoneNumber": "+59899123456",
    "status": "pending" // "pending", "active", "error"
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
