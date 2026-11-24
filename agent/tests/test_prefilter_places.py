"""Prefilter places: a user's "City, ST" matches postings that name the city any way; hybrid jobs are not remote."""
import pytest

from jobagent.discover.prefilter import location_ok


@pytest.mark.parametrize("loc,mode,ok", [
    ("Austin", "onsite_only", True), ("Austin, Texas, United States", "onsite_only", True),  # "Austin, TX" matched by its city
    ("Houston, TX", "onsite_only", False), ("Austinville", "onsite_only", False),
    ("Hybrid - Austin", "remote_only", False), ("Remote (US)", "remote_only", True),  # hybrid is not remote
    ("Hybrid - Boston", "remote_or_hybrid", True),
])
def test_location_matching(loc, mode, ok):
    assert location_ok({"title": "Analyst", "location": loc}, {"locations": ["Austin, TX", "Remote"], "remote": mode}) is ok
