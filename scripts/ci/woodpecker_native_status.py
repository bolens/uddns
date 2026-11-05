"""Verify exact native pipeline workflow statuses through GitHub's status history."""
import os
import re
import time


def pipeline_status(api, repository, sha, producer, native_repo, workflows, event):
    creator = os.environ.get("WOODPECKER_STATUS_CREATOR_ID", "")
    if not re.fullmatch(r"[1-9][0-9]*", creator):
        raise ValueError("trusted Woodpecker status creator is not configured")
    prefix = os.environ.get("WOODPECKER_STATUS_PREFIX", "ci/woodpecker")
    if not re.fullmatch(r"[A-Za-z0-9_./-]+", prefix):
        raise ValueError("invalid native status prefix")
    if not re.fullmatch(rf"https://woodpecker\.bolens\.dev/repos/{native_repo}/pipeline/[1-9][0-9]*", producer):
        raise ValueError("unexpected native pipeline producer")
    expected = {f"{prefix}/{event}/{workflow}" for workflow in workflows}
    selected = {}
    # A combined status loses earlier runs of the same SHA. Inspect bounded full
    # history, matching each exact pipeline URL and newest status ID per context.
    for page in range(1, 21):
        statuses = api(f"repos/{repository}/commits/{sha}/statuses?per_page=100&page={page}")
        if not isinstance(statuses, list):
            raise TypeError("invalid native status history")
        for status in statuses:
            context = status.get("context")
            if (context not in expected or status.get("creator", {}).get("id") != int(creator)
                    or not re.fullmatch(re.escape(producer) + r"/[1-9][0-9]*", status.get("target_url") or "")):
                continue
            if type(status.get("id")) is not int:
                raise TypeError("native status has no immutable sequence identity")
            if context not in selected or status["id"] > selected[context]["id"]:
                selected[context] = status
        if len(statuses) < 100:
            break
    else:
        raise ValueError("native status history exceeds the bounded verification window")
    if any(status["state"] in {"error", "failure"} for status in selected.values()):
        raise ValueError("the exact native producer pipeline failed")
    return set(selected) == expected and all(status["state"] == "success" for status in selected.values())


def wait_for_native_success(api, repository, sha, producer, native_repo, workflows, event):
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        if pipeline_status(api, repository, sha, producer, native_repo, workflows, event):
            return
        time.sleep(10)
    raise TimeoutError("the exact native pipeline did not reach all required successful workflows")
