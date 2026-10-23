"""Loaded by the voice-orders bench's worker process only (tools/arena/bench.mjs puts this folder on PYTHONPATH).

With RTSAI_BENCH_MODEL_ONLY=1 the companion's rule-based order interpreter answers nothing, so every order the player
gives is interpreted by the model under test. The companion's code is not changed; only this process is.
"""
import os

if os.environ.get("RTSAI_BENCH_MODEL_ONLY") == "1":
    from openra_ai_companion import nl_orders

    nl_orders.interpret_deterministic = lambda text, snapshot: None
