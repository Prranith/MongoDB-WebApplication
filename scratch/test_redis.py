import urllib.request
import json
import time

url = "https://choice-filly-171541.upstash.io/pipeline"
token = "gQAAAAAAAp4VAAIgcDE4NjFmNjc3ODY4NmU0ODE4YWZlNmJlYjJmMjRmMjUzMA"

headers = {
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json"
}

# Let's test a simple pipeline request
now = int(time.time())
payload = [
    ["ZADD", "active_users", str(now), "test_client_1"],
    ["ZREMRANGEBYSCORE", "active_users", "-inf", str(now - 60)],
    ["ZCARD", "active_users"],
    ["PFADD", "unique_visitors", "test_client_1"],
    ["PFCOUNT", "unique_visitors"]
]

req = urllib.request.Request(
    url,
    data=json.dumps(payload).encode("utf-8"),
    headers=headers,
    method="POST"
)

try:
    with urllib.request.urlopen(req) as response:
        res = json.loads(response.read().decode("utf-8"))
        print("Response:", json.dumps(res, indent=2))
except Exception as e:
    print("Error:", e)
