# Kafka, explained: a presenter’s guide

This guide answers the Kafka questions in plain language, using Apache Kafka’s documentation. It is written to be read aloud: short answers first, then the explanation and an example.

## Scope and source boundary

Apache Kafka is the source for Kafka topics, partitions, producers, consumers, offsets, groups, transactions, and replication. Apache Kafka does **not** include a built-in Schema Registry. The schema section therefore describes the Confluent Schema Registry product and labels it as such. Another registry can have different behavior.

The Apache producer configuration examples below describe the Java producer. Kafka’s wire protocol is used by many languages, but client defaults and option names can differ. A Ruby, Go, or Python client must be checked in its own documentation before assuming it behaves exactly like the Java client.

Examples in this guide are generic. They do not describe any particular company’s running system.

## 1. The basic picture

**Question: What is Kafka, in one sentence?**

Kafka is a distributed system that stores streams of records in named topics so producers can write them and consumers can read them, independently.

Think of a topic as a named log. A producer appends records to it. Kafka keeps those records for the configured retention period; reading a record does not normally delete it. Different consumer groups can read the same records independently. A record has a key, value, timestamp, and optional headers. [Apache Kafka: Introduction](https://kafka.apache.org/42/getting-started/introduction/)

**Question: Is a topic itself a partition?**

No. A topic is the named stream. It is split into one or more partitions. Each partition is an ordered log, and each record belongs to one topic and one partition. Kafka does not put records from two different topics into the same topic-partition.

The topic-partition is also the unit Kafka assigns to consumers in a traditional consumer group. [Apache Kafka: Introduction](https://kafka.apache.org/42/getting-started/introduction/) · [Apache Kafka: Design](https://kafka.apache.org/42/design/design/)

## 2. Producer routing and partitions

**Question: How does a record choose a topic?**

The producer’s application chooses the topic name when it publishes. Kafka does not inspect the business meaning of a value and decide which topic it belongs to. The producer sends a record addressed to a topic, and then a partition is selected within that topic.

**Question: How does the producer choose the partition?**

The producer client chooses it. It can be told the partition number directly, or it can run a partitioning strategy. With the Apache Java producer’s documented default logic:

- If the producer specifies a partition, that partition is used.
- If it does not specify a partition but the record has a key, the key is hashed to choose a partition.
- If neither partition nor key is supplied, the Java producer uses a sticky partitioning strategy for batching; the chosen partition changes as batches are produced.
- A custom partitioner can change this behavior.

So the broker does not see “dispute created” and decide where it belongs. It receives a produce request for a specific topic-partition selected by the client. [Apache Kafka: Producer configuration](https://kafka.apache.org/42/configuration/producer-configs/) · [Apache Kafka: ProducerRecord API](https://kafka.apache.org/42/javadoc/org/apache/kafka/clients/producer/ProducerRecord.html)

**Question: If I use `order-42` as the key, are all its records guaranteed to be ordered?**

They are routed to the same partition by the same key-based partitioning scheme, and Kafka preserves the order records are appended to that partition. The consumer reads that partition in log order.

That guarantee has boundaries. It is not a global order across all partitions. Producers must publish the related records in the intended sequence, and they must use a consistent key and partitioning arrangement. Increasing the partition count can change where a key hashes, so later records for a key can land in a different partition from its older records. Kafka does not move the old records. [Apache Kafka: Introduction](https://kafka.apache.org/42/getting-started/introduction/) · [Apache Kafka: Basic operations](https://kafka.apache.org/42/operations/basic-kafka-operations/)

**Question: How does Kafka know how many partitions a topic should have? Does it add another when one fills up?**

No. A partition is a growing log; it does not fill up and trigger a new partition. The topic’s partition count is selected when the topic is created, either explicitly or through the broker’s configured default. In Apache Kafka 4.2, the documented broker default `num.partitions` is 1 when no creation request supplies a count. An operator or admin tool can later increase the count. Kafka does not automatically add a partition because existing partitions have accumulated data. [Apache Kafka: Broker configuration](https://kafka.apache.org/42/configuration/broker-configs/) · [Apache Kafka: Basic operations](https://kafka.apache.org/42/operations/basic-kafka-operations/)

Some clusters can automatically create a missing topic when a client refers to it, depending on broker and client settings. That is a separate feature: it can create a topic with configured defaults, but it is not “add a partition when full.” For production, topic creation and partition count should be verified in the actual cluster configuration.

**Question: Why have multiple partitions?**

Partitions let Kafka distribute a topic’s storage and work across brokers and consumer instances. More partitions can provide more parallelism, up to the number of partitions for a traditional consumer group. They also divide ordering: Kafka gives order within each partition, not one total order across a multi-partition topic.

## 3. Consumers, groups, and offsets

**Question: How does a consumer know which topic and partition to read?**

The consumer application subscribes to topic names, or explicitly assigns topic-partitions. Kafka’s group coordination and assignment process gives members of a traditional consumer group the partitions they should read. The consumer then fetches records from those assigned topic-partitions. A record also carries its topic, partition, and offset, so the client knows where it came from. [Apache Kafka: Consumer API](https://kafka.apache.org/42/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html) · [Apache Kafka: ConsumerRecord API](https://kafka.apache.org/42/javadoc/org/apache/kafka/clients/consumer/ConsumerRecord.html)

Kafka does not randomly send a consumer to an unrelated topic’s partition. The subscription or assignment and the partition metadata determine the consumer’s work.

**Question: How do partitions and consumers relate inside a consumer group?**

For the traditional consumer-group model, a topic-partition is assigned to at most one active consumer in that group at a time. One consumer can own several partitions. If a group has more consumers than partitions for the subscribed topic, some consumers have no partition to process for that topic.

For example, with four partitions and two consumers in one group, each consumer can get two partitions. With four partitions and six consumers, at most four consumers can be active on those partitions at once. A different group can independently read all four partitions; that is how two applications can each receive the full topic stream. [Apache Kafka: Design](https://kafka.apache.org/42/design/design/) · [Apache Kafka: Consumer API](https://kafka.apache.org/42/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html)

This answer is specifically about traditional consumer groups. Kafka 4.2 also documents share groups, which have different assignment and acknowledgment behavior; do not mix those concepts into a presentation about ordinary consumer groups unless the system actually uses share groups.

**Question: What is an offset?**

An offset is a record’s position in one partition. Each partition has its own offset sequence. A consumer group keeps its committed position separately for each topic-partition. A committed position tells the group where it should resume; it is not a message deletion marker.

**Question: Does Kafka automatically commit offsets, or does the consumer commit them?**

Both styles exist. In the Apache Java consumer, `enable.auto.commit` defaults to `true`; when enabled, offsets are committed periodically in the background. An application can disable that and commit offsets itself, synchronously or asynchronously. Frameworks may wrap these choices and expose different settings. [Apache Kafka: Consumer configuration](https://kafka.apache.org/42/configuration/consumer-configs/) · [Apache Kafka: Design](https://kafka.apache.org/42/design/design/)

The important question is when the committed offset advances relative to the business work:

- If the application commits **before** processing finishes, a crash can make work disappear from that group’s view: it resumes after the committed position even though the work may not have completed.
- If it commits **after** processing finishes, a crash between finishing the work and committing can make the record be processed again.

This is why “consumer acknowledgment” is often an imprecise phrase. In a normal Kafka consumer, the application’s progress is represented by an offset commit. The consumer does not normally send a per-record `ack all` or `ack none` command like some queue systems do.

**Question: What happens if a consumer crashes halfway through a record?**

Kafka resumes that group from its last committed offset when a consumer takes over. If the failed work was not covered by a committed offset, the record is eligible to be read again. If the offset was committed before the work completed, Kafka will not know that the business work was incomplete; that work may be lost unless the application has another recovery mechanism.

The simplest safe mental model is: Kafka tracks the group’s position, not whether a database update, email, or payment in another system actually succeeded. [Apache Kafka: Design — consumer position and delivery semantics](https://kafka.apache.org/42/design/design/)

## 4. Ordering and keys

**Question: What does a key do?**

A key helps the producer consistently route related records to the same partition. For example, `order-42` can be used so that events for one order share a partition. The key does not sort records by itself. The order is the order in which records are appended to that partition.

**Question: Does Kafka guarantee that all messages arrive in business order?**

No. It guarantees order within a partition. If “created” and “resolved” for the same order must be processed in sequence, both must be routed to the same partition, and the producer must publish them in that sequence. If they go to different partitions, consumers can observe them at different times and process them in either relative order.

Using the same key is the common way to keep entity events together. A null key does not provide per-entity ordering. With the Java producer, unkeyed records can be distributed using sticky batching; another client or custom partitioner can behave differently. [Apache Kafka: Introduction](https://kafka.apache.org/42/getting-started/introduction/) · [Apache Kafka: Producer configuration](https://kafka.apache.org/42/configuration/producer-configs/)

**Question: Can there be one global ordering across the topic?**

Only if all records that need that total order are written to a single partition. That limits parallel consumption of that topic to one active traditional-group consumer for that partition. Multi-partition topics trade a single global order for parallelism.

## 5. Serialization and deserialization

**Question: What do serializers and deserializers do?**

Kafka stores and transfers record keys and values as bytes. A serializer turns the producer’s in-memory value into bytes before sending. A deserializer turns those bytes into something the consumer application can use. Kafka brokers store the bytes; they do not automatically understand a Ruby object, JSON object, Avro record, or business meaning.

The producer and consumer need compatible choices. If a producer writes JSON bytes but the consumer expects an Avro binary record, the consumer cannot decode the value just because both sides use Kafka.

**Question: What serializer types can be used?**

The practical options are:

- **String or primitive serializers.** Turn text, integers, and similar simple values into bytes. Apache Kafka’s Java client includes serializers and deserializers such as String, integer, long, UUID, and byte-array implementations.
- **Byte-array serializer.** Use this when the application already creates the bytes or uses a library to encode them.
- **JSON serializer.** Encode an object as JSON text. Plain JSON is easy to inspect, but Kafka itself does not enforce that every producer uses the same fields or types.
- **Schema-based serializer.** Encode records using a format such as Avro, Protobuf, or JSON Schema, often with a Schema Registry integration. The format and registry integration provide additional contract and evolution features; they are not automatically present just because Kafka is present.
- **Custom serializer.** Encode bytes in an application-specific format. The consumer must implement the corresponding decoder.

These are examples, not an exhaustive list. Serializer classes vary by client language. [Apache Kafka: serialization API](https://kafka.apache.org/42/javadoc/org/apache/kafka/common/serialization/package-summary.html) · [Apache Kafka: StringSerializer API](https://kafka.apache.org/42/javadoc/org/apache/kafka/common/serialization/StringSerializer.html)

**Question: Is JSON always a schema?**

No. JSON is a data format. A JSON document can have an expected shape, but unless the application validates it or a JSON Schema tool enforces a contract, Kafka will store the bytes without checking that shape.

## 6. Schema Registry and safe schema changes

**Question: Is Schema Registry part of Apache Kafka?**

No. Apache Kafka’s core broker does not require or provide a Schema Registry. A registry is a separate product or service that can store schemas, versions, and compatibility rules. Confluent Schema Registry is one example. Producers and consumers use it through compatible serializers and deserializers.

**Question: What problem does a registry solve?**

It gives producers and consumers a shared place to identify schema versions and check whether a proposed schema change meets a configured compatibility rule. That helps prevent some structurally incompatible changes from being registered. It does not prove that every consumer’s business logic is correct, and it does not make an unsafe change safe by itself.

**Question: Does the producer ask the registry to validate every message?**

Not necessarily. With Confluent serializers, configuration determines whether the serializer automatically registers schemas or uses schemas that were registered in advance. The serializer needs the schema information to encode the record. Schema IDs and client-side behavior are specific to that registry and serializer. Do not say “every message is checked against the registry” unless the chosen client’s documentation and configuration establish that.

For the Confluent wire format, an Avro record contains a format marker and schema ID followed by the encoded record data; it does not normally repeat the entire schema in every message. A compatible deserializer uses the ID to obtain the writer schema it needs to decode the data. Client caching and exact behavior depend on the library and configuration. [Confluent: Avro serializer and deserializer](https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/serdes-avro.html) · [Confluent: Schema Registry serializers overview](https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/overview.html)

**Question: Does every consumer have to approve a proposed schema?**

Not as a built-in Kafka or Confluent Schema Registry step. The registry can enforce its configured schema-compatibility rule when a schema is registered. It cannot know whether every application team has reviewed the change or whether their business code can use the new field correctly. Teams can add review, CI checks, contract tests, or an approval process around registration, but that is an organizational or tooling choice.

**Question: What do compatibility modes mean?**

Compatibility is about whether data written using one schema can be read using another schema under the selected format’s rules.

- **Backward:** a consumer using the new schema can read data written with the previous schema.
- **Forward:** a consumer using the previous schema can read data written with the new schema.
- **Full:** both directions are supported.
- **Transitive:** check against all earlier versions, not only the latest one.
- **None:** skip compatibility checks.

For Confluent Schema Registry, the documented default is `BACKWARD`, which is non-transitive. It checks a new schema against the latest registered version, not necessarily every version in the subject’s history. The actual mode can be changed globally or per subject, so “the registry default” is not proof of a particular deployment’s setting. Compatibility rules also vary with Avro, Protobuf, or JSON Schema. [Confluent: Schema evolution and compatibility](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)

**Question: Does a compatibility check guarantee that no consumer breaks?**

No. It checks schema-level compatibility according to the format and configured mode. It cannot prove that application logic interprets a value correctly, that a field’s meaning stayed the same, or that all consumers are deployed in a safe order.

For example, changing a field’s meaning from “amount in euros” to “amount in cents” may leave the field’s type and name unchanged, so a structural compatibility check might not catch the business break.

**Question: What if a producer adds a field used by only one consumer?**

Kafka delivers the whole record to each subscribed consumer. A consumer can use the fields it knows and ignore an additional field, if its format and deserializer allow that change. With a schema registry, the new field must satisfy the subject’s compatibility rules. For Avro and Protobuf, defaults can make certain additions compatible; the exact rule depends on format, field optionality, and compatibility mode. [Confluent: Schema evolution and compatibility](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)

**Question: Is renaming a field safe?**

Treat a rename as a potentially breaking change. Many formats and compatibility modes see it as removing one field and adding another. The precise result depends on the format’s rules and features. A registry may reject the change, or a change may pass a schema check while still breaking application logic.

A safer rollout is an expand-and-contract change: add a new field in a compatible way; update consumers to accept the old and new forms; start producing the new field while retaining the old one; confirm consumers have moved; then remove the old field in a later change if the compatibility policy permits it. Test each step using the actual serializer and compatibility mode.

**Question: How does the consumer know which schema to use?**

With a registry-aware format such as Confluent’s Avro wire format, the record carries a schema ID. The deserializer uses that ID to identify the schema for that record. It does not mean the consumer asks a human which version to select for each message, nor does it mean it blindly uses only the latest schema. Other formats and registry clients may represent schema information differently.

**Question: Could a production system run without a registry?**

Yes. Kafka accepts bytes. Teams can use plain JSON, custom validation, generated code, or other contract mechanisms without a registry. The trade-off is that schema storage, compatibility checking, version lookup, and enforcement must come from somewhere else—or be absent. Kafka does not require a registry.

## 7. Retries, acknowledgments, and idempotency

**Question: What does the producer acknowledgment setting, `acks`, mean?**

It controls how much broker acknowledgment the producer waits for before considering a write successful:

- **`acks=0`:** the producer does not wait for a broker acknowledgment. It has little evidence that the broker received the record.
- **`acks=1`:** the partition leader acknowledges after its local write. If it fails before followers copy the record, the record can be lost.
- **`acks=all` (also written `-1`):** the leader waits for the current in-sync replicas. “All” means all replicas currently in the ISR, not necessarily every replica originally assigned to the partition.

`acks=all` is not a magic guarantee on its own. `min.insync.replicas` can require a minimum number of in-sync replicas for writes to succeed. With `acks=all`, writes fail when the ISR is below that minimum, trading availability for the configured durability threshold. [Apache Kafka: Producer configuration](https://kafka.apache.org/42/configuration/producer-configs/) · [Apache Kafka: Design — replication](https://kafka.apache.org/42/design/design/)

**Question: Is `acks=all` the same as a consumer acknowledgment?**

No. Producer `acks` is a broker response about a publish. A consumer offset commit is the consumer group recording its read position. They happen at different ends of the flow and protect against different failure windows.

**Question: What do at-most-once, at-least-once, and exactly-once mean?**

- **At-most-once:** a record might be lost, but the processing is not repeated.
- **At-least-once:** a record is not intentionally skipped, but processing may happen more than once.
- **Exactly-once:** the defined processing effect is applied once under the specific system’s guarantee.

Kafka’s design documentation describes at-least-once as the general default pattern when a consumer processes first and commits its offset afterward. Committing before processing can create at-most-once behavior. Kafka transactions can atomically write Kafka output records and consumer offsets, supporting exactly-once processing from Kafka input to Kafka output when configured correctly. Effects in an external database or payment system need that system’s cooperation or an application-level atomicity/deduplication design. [Apache Kafka: Design — delivery semantics and transactions](https://kafka.apache.org/42/design/design/)

**Question: What does producer idempotence protect against?**

The Java producer’s idempotence feature prevents duplicate log entries caused by its own retries for a producer session, within Kafka’s documented guarantee. Current Apache Java producer configuration enables idempotence by default when settings do not conflict. A different Kafka client may have different defaults. Idempotence is distinct from the business-level question of whether two separate application requests represent the same real-world action. [Apache Kafka: Producer configuration](https://kafka.apache.org/42/configuration/producer-configs/)

**Question: Does Kafka automatically prevent consumers from processing a record twice?**

No. If the consumer finishes a database update and crashes before committing the Kafka offset, it can receive that record again. Kafka’s transactional mechanism can coordinate Kafka output and offsets. For an external side effect, an application commonly needs an idempotent operation or deduplication key—for example, a unique event ID stored with the database effect. The exact design depends on the destination system.

**Question: What does retry mean?**

There are different retry layers. A producer client can retry a temporary publish failure. A consumer application can retry failed processing, pause a partition, retry a record, restart, skip, or route a record elsewhere. Kafka does not automatically re-run arbitrary application business logic just because it threw an exception. The framework or application defines that policy.

Producer retries also interact with ordering. The Apache Java producer documents that with idempotence disabled, retries and multiple in-flight requests can allow later batches to appear before a retried earlier batch. Idempotence or appropriate in-flight settings protect the producer’s per-partition order under those retry conditions. [Apache Kafka: Producer configuration](https://kafka.apache.org/42/configuration/producer-configs/)

## 8. Dead-letter queues

**Question: Does Kafka have a built-in dead-letter queue for every consumer?**

No. A dead-letter queue, often called a DLQ or dead-letter topic, is a handling pattern. Kafka core does not automatically move every failed record there. The consumer application or framework must be configured to publish failed records to a separate topic, usually with failure context, and someone must decide how to inspect and replay them.

Apache Kafka Connect does provide configurable dead-letter handling for certain connector errors. That is a Kafka Connect feature, not an automatic behavior of every consumer client. [Apache Kafka Connect: error reporting](https://kafka.apache.org/42/kafka-connect/user-guide/)

**Question: If there is no DLQ, does one bad record block the whole topic?**

Not necessarily the whole topic. If an application stops at a failing record and does not advance that partition’s committed position, later records in that partition may wait behind it. Other partitions can continue if their consumers keep processing. A retry loop, skip policy, DLQ, or operator intervention changes that outcome. Kafka does not pick one of those policies for a general consumer.

**Question: Who decides and configures a DLQ?**

The application/framework team decides how failures should be handled. For Kafka Connect, the connector has explicit error-handling settings. For a custom consumer, the application must implement or configure the behavior. A DLQ is useful only with an operational process: monitoring, ownership, secure handling of payloads, investigation, correction, and replay or intentional discard.

## 9. Replication and broker failures

**Question: What is replication factor?**

It is the number of replicas configured for each topic-partition. One replica is the leader for reads and writes; other replicas copy its log. Replication spreads partition copies across brokers to improve resilience. A replication factor of three is a common production example in Apache’s introduction, not a required default for every topic or cluster. [Apache Kafka: Introduction](https://kafka.apache.org/42/getting-started/introduction/)

**Question: What is the ISR?**

ISR means in-sync replicas: replicas currently caught up enough to be considered in sync with the partition leader. With `acks=all`, the leader waits for the current ISR. If `min.insync.replicas` requires more replicas than are currently in sync, Kafka rejects the write instead of acknowledging it below that threshold. This protects durability at the cost of availability for that write. [Apache Kafka: Design — replication](https://kafka.apache.org/42/design/design/) · [Apache Kafka: Topic configuration](https://kafka.apache.org/42/configuration/topic-configs/)

**Question: Does replication mean a broker failure can never lose data?**

No. The outcome depends on which replicas had the record, the producer’s `acks`, the ISR, `min.insync.replicas`, leader-election settings, and the failure pattern. Replication improves fault tolerance; it is not an unconditional no-loss promise. State the actual cluster configuration and incident evidence before making a claim about a specific deployment.

## 10. Quick answers for a presentation

**“Who picks the partition?”** The producer client does. It uses an explicit partition, a key-based partitioner, or another configured strategy.

**“Do records disappear when consumed?”** No. Kafka retains records according to topic policy. A consumer group commits its own position; that does not delete the records.

**“Can several services read the same topic?”** Yes. Give each independent reader its own consumer group if each needs its own full copy of the stream.

**“Does Kafka guarantee order?”** Within a partition. A key commonly routes one entity’s events to the same partition. There is no total ordering across multiple partitions.

**“What happens after a consumer crash?”** It resumes from the group’s last committed offset. Depending on when the offset was committed, work may repeat or may have been skipped.

**“Does Kafka have exactly-once processing?”** Kafka transactions can provide exactly-once processing for Kafka-to-Kafka flows when used correctly. External side effects need cooperation from the external system or application-level safeguards.

**“Does Kafka require Schema Registry?”** No. Kafka stores bytes. A registry is a separate component that can manage schemas and enforce configured compatibility rules when clients use compatible serializers and deserializers.

**“Does Schema Registry guarantee consumers will not break?”** No. It can reject certain schema-incompatible changes. It cannot certify business logic or replace safe rollout and testing.

**“Does Kafka automatically send failed messages to a DLQ?”** No. Kafka core does not. An application/framework must implement it; Kafka Connect has its own configurable error/DLQ feature.

## Official references

### Apache Kafka

- [Introduction and core concepts](https://kafka.apache.org/42/getting-started/introduction/)
- [Design, consumer position, transactions, delivery semantics, and replication](https://kafka.apache.org/42/design/design/)
- [Producer configuration](https://kafka.apache.org/42/configuration/producer-configs/)
- [Consumer configuration](https://kafka.apache.org/42/configuration/consumer-configs/)
- [Broker configuration](https://kafka.apache.org/42/configuration/broker-configs/)
- [Topic configuration](https://kafka.apache.org/42/configuration/topic-configs/)
- [Basic operations and partition management](https://kafka.apache.org/42/operations/basic-kafka-operations/)
- [Kafka Connect error reporting and DLQ settings](https://kafka.apache.org/42/kafka-connect/user-guide/)
- [Consumer API](https://kafka.apache.org/42/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html)
- [Producer record API](https://kafka.apache.org/42/javadoc/org/apache/kafka/clients/producer/ProducerRecord.html)
- [Consumer record API](https://kafka.apache.org/42/javadoc/org/apache/kafka/clients/consumer/ConsumerRecord.html)
- [Serialization API package](https://kafka.apache.org/42/javadoc/org/apache/kafka/common/serialization/package-summary.html)

### Confluent Schema Registry (vendor-specific; not Apache Kafka core)

- [Schema evolution and compatibility](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)
- [Schema formats and SerDes overview](https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/overview.html)
- [Avro serializer and deserializer](https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/serdes-avro.html)
