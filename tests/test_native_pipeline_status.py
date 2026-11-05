"""Only the requested native pipeline's trusted workflow statuses permit promotion."""
import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("native_status", Path(__file__).resolve().parents[1] / "scripts/ci/woodpecker_native_status.py")
status = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(status)
PRODUCER = "https://woodpecker.bolens.dev/repos/11/pipeline/12"


class NativeStatusTests(unittest.TestCase):
    def row(self, workflow="woodpecker", state="success", **changes):
        return {"id": 1, "context": "ci/woodpecker/push/" + workflow,
                "creator": {"id": 123}, "state": state, "target_url": PRODUCER + "/1", **changes}

    def verify(self, rows):
        with patch.dict(os.environ, {"WOODPECKER_STATUS_CREATOR_ID": "123"}, clear=True):
            return status.pipeline_status(lambda _: rows, "bolens/audio-utils", "a" * 40,
                                          PRODUCER, 11, ["woodpecker", "publishing"], "push")

    def test_all_expected_workflows_from_exact_producer_succeed(self):
        self.assertTrue(self.verify([self.row(), self.row("publishing")]))

    def test_missing_pending_foreign_creator_pipeline_and_context_do_not_succeed(self):
        for row in [None, self.row("publishing", state="pending"),
                    self.row("publishing", creator={"id": 456}),
                    self.row("publishing", target_url=PRODUCER.replace("/12", "/13") + "/1"),
                    self.row("publishing", context="ci/woodpecker/pr/publishing")]:
            with self.subTest(row=row):
                self.assertFalse(self.verify([self.row()] + ([row] if row else [])))

    def test_newest_status_for_requested_pipeline_overrides_older_success(self):
        with self.assertRaisesRegex(ValueError, "pipeline failed"):
            self.verify([self.row(), self.row("publishing"), self.row("publishing", state="failure", id=2)])
        self.assertTrue(self.verify([self.row(), self.row("publishing", state="failure"), self.row("publishing", id=2)]))

    def test_unconfigured_creator_and_wrong_native_repo_are_denied(self):
        for environment, producer in [({}, PRODUCER), ({"WOODPECKER_STATUS_CREATOR_ID": "123"}, PRODUCER.replace("/11/", "/12/"))]:
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=True), self.assertRaises(ValueError):
                status.pipeline_status(lambda _: [], "bolens/audio-utils", "a" * 40, producer, 11, ["publishing"], "push")

    def test_malformed_status_response_fails_closed(self):
        with self.assertRaises(TypeError):
            self.verify({"unexpected": "object"})
        with self.assertRaises(TypeError):
            self.verify([self.row(id="not-an-integer")])

    def test_paginated_history_and_resource_bound(self):
        pages = [[self.row(context="unrelated", id=number) for number in range(100)], [self.row(), self.row("publishing")]]
        with patch.dict(os.environ, {"WOODPECKER_STATUS_CREATOR_ID": "123"}, clear=True):
            self.assertTrue(status.pipeline_status(lambda _: pages.pop(0), "bolens/audio-utils", "a" * 40, PRODUCER, 11, ["woodpecker", "publishing"], "push"))
            with self.assertRaisesRegex(ValueError, "bounded verification"):
                status.pipeline_status(lambda _: [self.row()] * 100, "bolens/audio-utils", "a" * 40, PRODUCER, 11, ["woodpecker"], "push")
