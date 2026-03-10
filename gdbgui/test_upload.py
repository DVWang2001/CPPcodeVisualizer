import requests

code = """
#include <iostream>
using namespace std;
int main() {
    cout << "test" << endl;
    return 0;
}
"""

print("Simulating create_and_upload request...")
try:
    # First, let's just see if we can trigger the endpoint
    res = requests.post("http://127.0.0.1:5000/create_and_upload", data={
        "code": code,
        "filepath": "/app/gdbgui/server/uploads/default_hello_abc.cpp",
        "program_input": ""
    }, headers={"Accept": "application/json"})
    print(f"Status Code: {res.status_code}")
    print(f"Headers: {res.headers}")
    print(f"Response Body: {res.text}")
except Exception as e:
    print(f"Error: {e}")
