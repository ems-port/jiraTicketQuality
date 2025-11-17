

import os
import requests
from dotenv import load_dotenv
# API TESTING SCRIPT FOR JIRA
# Load environment variables from .env file
load_dotenv()

# Use correct .env variable names
JIRA_API_TOKEN = os.getenv('JIRA_API_KEY')
JIRA_EMAIL = os.getenv('JIRA_EMAIL')
JIRA_BASE_URL = 'https://portapp.atlassian.net'

# 1. Check if API key works by calling /myself
print("\n--- Checking if API key works (/myself endpoint) ---")
myself_url = f"{JIRA_BASE_URL}/rest/api/3/myself"
myself_response = requests.get(myself_url, auth=(JIRA_EMAIL, JIRA_API_TOKEN))
print(f"/myself status code: {myself_response.status_code}")
try:
    myself_data = myself_response.json()
    print("/myself response:", myself_data)
except Exception as e:
    print(f"Failed to parse /myself JSON: {e}")
    print(myself_response.text)

# 2. Try fetching tickets with JQL using the latest search/jql endpoint and request key field
JQL = 'project = CC AND statusCategory = Done AND created >= "2025-11-01" ORDER BY created DESC'
url = f"{JIRA_BASE_URL}/rest/api/3/search/jql"
headers = {
    "Accept": "application/json",
    "Content-Type": "application/json"
}
auth = (JIRA_EMAIL, JIRA_API_TOKEN)
payload = {
    'jql': JQL,
    'maxResults': 5,
    'fields': ["key"]
}
print(f"Requesting: {url}")
print(f"Payload: {payload}")
print(f"Headers: {headers}")
print(f"Auth user: {JIRA_EMAIL}")
response = requests.post(url, headers=headers, json=payload, auth=auth)
print(f"Status code: {response.status_code}")
try:
    data = response.json()
except Exception as e:
    print(f"Failed to parse JSON: {e}")
    print(response.text)
    exit(1)
if response.status_code == 200:
    issues = data.get('issues', [])
    if not issues:
        print("No issues found in response.")
        print(f"Full response: {data}")
    else:
        print("First 5 ticket keys:")
        for i, issue in enumerate(issues, 1):
            print(f"{i}: {issue.get('key')}")
else:
    print(f"Failed to fetch tickets: {response.status_code}")
    print(data)

# 3. List all projects visible to the bot user
print("\n--- Listing all projects visible to the bot user ---")
projects_url = f"{JIRA_BASE_URL}/rest/api/3/project/search"
projects_response = requests.get(projects_url, headers=headers, auth=auth)
print(f"Projects status code: {projects_response.status_code}")
try:
    projects_data = projects_response.json()
    print(f"Found {projects_data.get('total', 'unknown')} projects.")
    for proj in projects_data.get('values', []):
        print(f"Key: {proj.get('key')}, Name: {proj.get('name')}")
    if not projects_data.get('values'):
        print(f"Full response: {projects_data}")
except Exception as e:
    print(f"Failed to parse projects JSON: {e}")
    print(projects_response.text)
