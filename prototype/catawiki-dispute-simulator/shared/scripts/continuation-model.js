export function createModel() {
  return {
    logs: [[], []], next: [0, 0], position: [0, 0],
    serviceNext: { orders: [0, 0], message: [0, 0] },
    effects: {}, handled: [], dlq: [], failed: null, attempts: 0,
    schemas: [], cache: [], registryRequests: 0, businessError: null,
    storedNext: [0, 0], retryAttempts: [0, 0], retryExhausted: [false,false], journal: [], businessSequence: 49328,
  };
}

export function appendRecord(model, partition, fields = {}) {
  const record = { partition, offset: model.logs[partition].length, event: "DisputeCreated", ...fields };
  record.eventId ??= `dispute-${model.businessSequence++}:created`;
  model.logs[partition].push(record);
  return record;
}

export function commitRecord(model, record) {
  if (model.next[record.partition] !== record.offset) throw new Error("Commit must follow partition order");
  model.next[record.partition] = record.offset + 1;
}

export function applyEffect(model, record, idempotent = false) {
  if (idempotent && model.handled.includes(record.eventId)) return false;
  model.effects[record.eventId] = (model.effects[record.eventId] ?? 0) + 1;
  if (idempotent) model.handled.push(record.eventId);
  return true;
}

export function appendDeadLetter(model, record) {
  const entry = { partition: 0, offset: model.dlq.length, eventId: record.eventId,
    sourceTopic: "customer_info_disputes", sourcePartition: record.partition,
    sourceOffset: record.offset, error: "UnsupportedBusinessValue", event: record.event,
    payload: structuredClone(record.payload), attempts: model.retryAttempts[record.partition],
    failureContext: "Finance rejects reason=unsupported; selected bounded APP LOGIC policy" };
  model.dlq.push(entry);
  return entry;
}

export const jsonSchemaV1 = {
  type: "object",
  properties: { dispute_id: { type: "integer" }, order_id: { type: "integer" }, reason: { type: "string" } },
  required: ["dispute_id", "order_id", "reason"],
  additionalProperties: false,
};
export const incompatibleJsonSchema = {
  ...jsonSchemaV1,
  properties: { order_dispute_id: { type: "integer" }, order_id: { type: "integer" }, reason: { type: "string" } },
  required: ["order_dispute_id", "order_id", "reason"],
};

export const jsonSchemaV2 = {
  ...jsonSchemaV1,
  properties: { ...jsonSchemaV1.properties, note: { type: "string" } },
};

// Selected closed JSON examples under configured STRICT/BACKWARD; not a general schema validator.
export function registerSchema(model, schema) {
  const existing = model.schemas.find(entry => JSON.stringify(entry.schema) === JSON.stringify(schema));
  if (existing) return { status: 200, ...existing };
  const previous = model.schemas.at(-1)?.schema;
  if (previous) {
    const changed = Object.entries(previous.properties).some(([name, property]) => schema.properties[name]?.type !== property.type);
    const requiredAdded = schema.required.some(name => !previous.required.includes(name));
    if (changed || requiredAdded || schema.additionalProperties !== false) return { status: 409 };
  }
  const entry = { id: model.schemas.length + 1, version: model.schemas.length + 1, schema: structuredClone(schema) };
  model.schemas.push(entry);
  return { status: 200, ...entry };
}

export function validatesJson(schema, payload) {
  return schema.required.every(field => Object.hasOwn(payload, field)) && Object.entries(payload).every(([field, value]) => {
    const property = schema.properties[field];
    return property && (property.type === "integer" ? Number.isInteger(value) : typeof value === "string");
  });
}
