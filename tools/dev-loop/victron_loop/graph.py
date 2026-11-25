from __future__ import annotations

from pathlib import Path
from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from .gh import GhCli
from .nodes import LoopConfig, check_state, notify, pick_task, start_worker, watch_pr


class LoopState(TypedDict, total=False):
    observed: dict[str, Any]
    pick: dict[str, Any]
    active_worker: dict[str, Any] | None
    approved: list[str]
    notifications_sent: dict[str, int]
    daily_counts: dict[str, int]
    last_summary_date: str | None


def build_graph(cfg: LoopConfig, gh: GhCli, backlog_path: Path):
    graph = StateGraph(LoopState)
    graph.add_node("check_state", lambda s: check_state(s, cfg, gh))
    graph.add_node("pick_task", lambda s: pick_task(s, cfg, backlog_path))
    graph.add_node("start_worker", lambda s: start_worker(s, cfg))
    graph.add_node("watch_pr", lambda s: watch_pr(s, cfg, gh))
    graph.add_node("notify", lambda s: notify(s, cfg))
    graph.set_entry_point("check_state")
    graph.add_edge("check_state", "pick_task")
    graph.add_edge("pick_task", "start_worker")
    graph.add_edge("start_worker", "watch_pr")
    graph.add_edge("watch_pr", "notify")
    graph.add_edge("notify", END)
    return graph.compile()

