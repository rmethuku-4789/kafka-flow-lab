# Presenter runbook

Use `npm run dev`, then open `http://127.0.0.1:4177/recap`. These pages use synthetic teaching data, not a running Kafka cluster.

| Scenario | URL |
| --- | --- |
| Recap | `/recap` |
| Consumer groups | `/groups` |
| Broker failure | `/broker-failure` |
| Retries & DLQ | `/retries-dlq` |
| Offsets & idempotency | `/offsets-idempotency` |
| Schema evolution | `/schema-evolution` |

Use the scenario dropdown to switch pages and the bottom controls to pause, adjust speed, replay, or advance. Present each topic as question → audience discussion → simulator → takeaways.
