"""CloudAMQP execution worker.

Run this as a separate long-lived service, not inside a Vercel function:

    python -m services.execution.worker
"""

import json
import os
import signal
import time

from services.execution.job_queue import QUEUE_NAMES, QUEUE_URL, process


def main():
    if not QUEUE_URL:
        raise SystemExit("CLOUDAMQP_URL is required")
    import pika

    reconnect_seconds = max(1, int(os.getenv("EXECUTION_WORKER_RECONNECT_SECONDS", "5")))
    stopping = False

    def stop_worker(*_args):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop_worker)
    signal.signal(signal.SIGINT, stop_worker)

    while not stopping:
        connection = None
        try:
            connection = pika.BlockingConnection(pika.URLParameters(QUEUE_URL))
            channel = connection.channel()
            for queue_name in sorted(set(QUEUE_NAMES.values())):
                channel.queue_declare(queue=queue_name, durable=True)
            channel.basic_qos(prefetch_count=max(1, int(os.getenv("EXECUTION_WORKER_PREFETCH", "1"))))

            def consume(message_channel, method, properties, body):
                started = time.monotonic()
                job_id = "unknown"
                kind = "unknown"
                try:
                    message = json.loads(body.decode("utf-8"))
                    job_id = str(message["jobId"])
                    kind = str(message["kind"])
                    print(f"[CodeLeaf worker] received {kind} job {job_id}", flush=True)
                    # Payloads stay in MongoDB; RabbitMQ carries only a small
                    # job envelope so retries and large source/query bodies are safe.
                    outcome = process(job_id, kind)
                    elapsed_ms = round((time.monotonic() - started) * 1000)
                    print(f"[CodeLeaf worker] {outcome} {kind} job {job_id} ({elapsed_ms} ms)", flush=True)
                    message_channel.basic_ack(delivery_tag=method.delivery_tag)
                except Exception as exc:
                    # A malformed envelope or unexpected worker failure must
                    # not poison the queue forever. The job record is marked
                    # failed when process() can identify it; the message is
                    # acknowledged after recording the failure.
                    elapsed_ms = round((time.monotonic() - started) * 1000)
                    print(f"[CodeLeaf worker] failed {kind} job {job_id} ({elapsed_ms} ms): {exc}", flush=True)
                    message_channel.basic_nack(delivery_tag=method.delivery_tag, requeue=False)

            for queue_name in sorted(set(QUEUE_NAMES.values())):
                channel.basic_consume(queue=queue_name, on_message_callback=consume)
            print("CodeLeaf execution worker is listening", flush=True)
            while not stopping and connection.is_open:
                connection.process_data_events(time_limit=1)
        except Exception as exc:
            if not stopping:
                print(f"execution worker connection failed: {exc}; retrying", flush=True)
                time.sleep(reconnect_seconds)
        finally:
            if connection is not None and connection.is_open:
                connection.close()


if __name__ == "__main__":
    main()
