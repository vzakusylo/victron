import re
from pathlib import Path


def test_dashboard_deploy_is_on_omarchy_without_github_secrets():
    workflows = Path(__file__).resolve().parents[3] / ".github" / "workflows"
    dashboard = (workflows / "deploy-langchain-dashboard.yml").read_text(encoding="utf-8")
    general = (workflows / "deploy-dev-loop.yml").read_text(encoding="utf-8")
    assert re.search(r"^\s*runs-on: \[self-hosted, omarchy\]$", dashboard, re.MULTILINE)
    assert "secrets." not in dashboard
    for workflow in (dashboard, general):
        assert re.search(r"^concurrency:\n  group: dev-loop-deploy$", workflow, re.MULTILINE)
