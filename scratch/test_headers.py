import urllib.request

url = "https://practice-mongodb.vercel.app//sitemap.xml"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"})

try:
    with urllib.request.urlopen(req) as response:
        print("Status Code:", response.status)
        print("Content-Type:", response.getheader("Content-Type"))
        print("Body Length:", len(response.read()))
except Exception as e:
    print("Error:", e)
