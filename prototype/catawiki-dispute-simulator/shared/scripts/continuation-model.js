export function createModel() {
  return {
    logs: [[], []], next: [0, 0], position: [0, 0],
    serviceNext: { orders: [0, 0], message: [0, 0] },
    effects: {}, handled: [], dlq: [], failed: null, attempts: 0,
    schemas: [], cache: [], registryRequests: 0, businessError: null,
    archives: [], avroTopic: false,
  };
}

export function appendRecord(model, partition, fields = {}) {
  const record = { partition, offset: model.logs[partition].length, event: "DisputeCreated", ...fields };
  record.eventId ??= `event-${partition}-${record.offset}`;
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
    sourceOffset: record.offset, error: "DatabaseTimeout", event: record.event };
  model.dlq.push(entry);
  return entry;
}

export const schemaV1 = { type: "record", name: "DisputeCreated", fields: [
  { name: "event_id", type: "string" }, { name: "user_id", type: "string" },
] };
export const incompatibleSchema = { ...schemaV1, fields: [
  { name: "event_id", type: "string" }, { name: "user_id", type: "int" },
] };
export const compatibleSchema = { ...schemaV1, fields: [
  ...schemaV1.fields, { name: "note", type: ["null", "string"], default: null },
] };

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

export function registerSchema(model, schema) {
  const previous = model.schemas.at(-1)?.schema;
  if (previous?.type === "object" && schema.type === "object") {
    const typeChanged = Object.entries(previous.properties).some(([name, property]) => !schema.properties[name] || property.type !== schema.properties[name].type);
    const requiredAdded = schema.required.some((name) => !previous.required.includes(name));
    const closedFieldAdded = previous.additionalProperties === false && Object.keys(schema.properties).some((name) => !Object.hasOwn(previous.properties, name));
    if (typeChanged || requiredAdded || closedFieldAdded) return { status: 409 };
  } else if (previous) {
    const typeChanged = previous.fields.some((field) => {
      const updated = schema.fields.find((candidate) => candidate.name === field.name);
      return !updated || JSON.stringify(field.type) !== JSON.stringify(updated.type);
    });
    const requiredAdded = schema.fields.some((field) => !previous.fields.some((candidate) => candidate.name === field.name) && !Object.hasOwn(field, "default"));
    if (typeChanged || requiredAdded) return { status: 409 };
  }
  const existing = model.schemas.find((entry) => JSON.stringify(entry.schema) === JSON.stringify(schema));
  if (existing) return { status: 200, ...existing };
  const entry = { id: model.schemas.length + 1, version: model.schemas.length + 1, schema: structuredClone(schema) };
  model.schemas.push(entry);
  return { status: 200, ...entry };
}

export function beginAvroTopic(model) {
  if (model.avroTopic) return;
  model.archives.push({ topic: "customer_info_disputes", logs: model.logs, next: model.next,
    position: model.position, serviceNext: model.serviceNext, businessError: model.businessError });
  model.logs = [[], []];
  model.next = [0, 0];
  model.position = [0, 0];
  model.serviceNext = { orders: [0, 0], message: [0, 0] };
  model.businessError = null;
  model.avroTopic = true;
}
