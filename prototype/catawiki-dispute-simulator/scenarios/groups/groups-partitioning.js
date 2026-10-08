// Default Kafka Java producer: StringSerializer (UTF-8), Murmur2, positive hash modulo partition count.
// Reference: Apache Kafka 4.2 BuiltInPartitioner.partitionForKey and Utils.murmur2.
export function partitionForKey(key, count) {
  const bytes = new TextEncoder().encode(key);
  const m = 0x5bd1e995;
  let h = 0x9747b28c ^ bytes.length;
  let index = 0;
  for (; index + 4 <= bytes.length; index += 4) {
    let k = bytes[index] | bytes[index + 1] << 8 | bytes[index + 2] << 16 | bytes[index + 3] << 24;
    k = Math.imul(k, m); k ^= k >>> 24; k = Math.imul(k, m);
    h = Math.imul(h, m) ^ k;
  }
  const remaining = bytes.length - index;
  if (remaining >= 3) h ^= bytes[index + 2] << 16;
  if (remaining >= 2) h ^= bytes[index + 1] << 8;
  if (remaining >= 1) { h ^= bytes[index]; h = Math.imul(h, m); }
  h ^= h >>> 13; h = Math.imul(h, m); h ^= h >>> 15;
  return (h & 0x7fffffff) % count;
}
