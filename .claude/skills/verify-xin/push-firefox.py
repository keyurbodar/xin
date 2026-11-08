#!/usr/bin/python3
"""Prove a notification made the whole trip: Worker -> Mozilla autopush -> this browser.

Chromium (and the headless build agent-browser ships) cannot hold a push subscription
here, so this drives Firefox ESR through geckodriver, turns push on through the real
Settings pane, and then checks what the service worker actually received.

usage:
  /usr/bin/python3 .claude/skills/verify-xin/push-firefox.py \
      --client http://localhost:5174 --worker http://127.0.0.1:8799 \
      --token verify-owner-token --geckodriver /tmp/geckodriver \
      --shot .verify/shots/P14-push-firefox.png
"""

import argparse
import json
import sys
import time
import urllib.request

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--client", default="http://localhost:5174")
    parser.add_argument("--worker", default="http://127.0.0.1:8799")
    parser.add_argument("--token", default="verify-owner-token")
    parser.add_argument("--geckodriver", default="/tmp/geckodriver")
    parser.add_argument("--shot", default="")
    parser.add_argument("--wait", type=int, default=90)
    return parser.parse_args()


def browser(driver_path: str) -> webdriver.Firefox:
    options = Options()
    options.add_argument("-headless")
    options.set_preference("permissions.default.desktop-notification", 1)
    options.set_preference("dom.push.connection.enabled", True)
    options.set_preference("dom.push.enabled", True)
    return webdriver.Firefox(options=options, service=Service(driver_path))


def call(worker: str, token: str, op: str, args: dict) -> dict:
    body = json.dumps({"id": f"firefox-{op}-{time.time()}", "op": op, "args": args}).encode()
    request = urllib.request.Request(
        f"{worker}/v1/cmd",
        data=body,
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as reply:
        return json.loads(reply.read())


def subscription(browser: webdriver.Firefox) -> dict | None:
    return browser.execute_async_script(
        """
        const done = arguments[arguments.length - 1];
        navigator.serviceWorker.getRegistration('/sw.js')
          .then(r => r ? r.pushManager.getSubscription() : null)
          .then(s => done(s ? { endpoint: s.endpoint } : null))
          .catch(e => done({ error: e.name + ': ' + e.message }));
        """
    )


def notifications(browser: webdriver.Firefox) -> list:
    return browser.execute_async_script(
        """
        const done = arguments[arguments.length - 1];
        navigator.serviceWorker.getRegistration('/sw.js')
          .then(r => r ? r.getNotifications() : [])
          .then(ns => done(ns.map(n => ({ title: n.title, body: n.body, tag: n.tag }))))
          .catch(e => done([{ error: e.name + ': ' + e.message }]));
        """
    )


def main() -> int:
    args = parse_args()
    browser_ = browser(args.geckodriver)
    try:
        browser_.get(f"{args.client}/#/signin?token={args.token}")
        WebDriverWait(browser_, 30).until(
            lambda b: b.find_elements(By.XPATH, "//button[normalize-space()='Continue']")
        )
        browser_.find_element(By.XPATH, "//button[normalize-space()='Continue']").click()
        WebDriverWait(browser_, 30).until(lambda b: "Home" in b.title or b.find_elements(By.XPATH, "//*[text()='Home']"))
        print("signed in")

        browser_.get(f"{args.client}/#/settings/notifications")
        WebDriverWait(browser_, 30).until(
            lambda b: b.find_elements(By.XPATH, "//button[normalize-space()='Enable push']")
            or b.find_elements(By.XPATH, "//*[contains(text(),'Turn off')]")
        )
        browser_.execute_script(
            """
            window.__xinPush = [];
            navigator.serviceWorker.addEventListener('message', (event) => {
              const data = event.data;
              if (data && data.type === 'xin-push') window.__xinPush.push(data);
            });
            """
        )
        buttons = browser_.find_elements(By.XPATH, "//button[normalize-space()='Enable push']")
        if buttons:
            buttons[0].click()
        WebDriverWait(browser_, 60).until(lambda b: subscription(b) not in (None, {}) or False)
        found = subscription(browser_)
        if found is None or "error" in (found or {}):
            print("no subscription:", found)
            return 1
        print("subscribed:", found["endpoint"])

        delivered = call(args.worker, args.token, "push.test", {})
        print("push.test:", json.dumps(delivered))

        deadline = time.time() + args.wait
        seen: list = []
        while time.time() < deadline:
            seen = browser_.execute_script("return window.__xinPush")
            if seen:
                break
            time.sleep(2)
        print("service worker heard:", json.dumps(seen))
        print("shown notifications:", json.dumps(notifications(browser_)))

        if args.shot:
            browser_.save_screenshot(args.shot)
            print("shot:", args.shot)
        return 0 if seen else 1
    finally:
        browser_.quit()


if __name__ == "__main__":
    sys.exit(main())
