"""Verify the actual macOS app's resource seal; developer trust is reported separately."""
import argparse
import json
import os
from pathlib import Path
import pwd
import subprocess
from datetime import datetime, timezone


def run(argv):
    try:
        process = subprocess.run(argv, capture_output=True, text=True, timeout=30)
        return {"argv": argv, "exit_code": process.returncode,
                "stdout": process.stdout, "stderr": process.stderr}
    except subprocess.TimeoutExpired:
        return {"argv": argv, "timeout_s": 30, "exit_code": None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    app = str(args.app.resolve())
    display = run(["/usr/bin/codesign", "-dv", "--verbose=4", app])
    verify = run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", app])
    assessment = run(["/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=2", app])
    quarantine = run(["/usr/bin/xattr", "-p", "com.apple.quarantine", app])
    passed = verify["exit_code"] == 0
    report = {"status": "passed" if passed else "failed", "app": app,
              "uid": os.getuid(), "user": pwd.getpwuid(os.getuid()).pw_name,
              "observed_at": datetime.now(timezone.utc).isoformat(),
              "codesign_display": display, "codesign_verify": verify,
              "gatekeeper_assessment": assessment, "quarantine": quarantine,
              "scope": "actual public app resource-seal verification; ad-hoc success is not Developer ID, notarization, downloaded installation, or clean-Mac trust acceptance"}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    if not passed:
        raise SystemExit("FAIL: actual .app resource seal is invalid; see " + str(args.report))
    print("PASS: actual .app codesign --verify --deep --strict; trust recorded separately")


if __name__ == "__main__":
    main()
