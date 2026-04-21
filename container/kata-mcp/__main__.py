# __main__.py — Entry point for the Kata MCP server
from server import mcp

# Import tool modules — each registers its tools on the shared `mcp` instance
import tools.benchmark   # noqa: F401 — kata_benchmark, kata_smoke_test
import tools.knowledge   # noqa: F401 — kata_read_knowledge, kata_record_experiment
import tools.inspect     # noqa: F401 — kata_inspect_market, kata_check_graduation, kata_validate_strategy


if __name__ == "__main__":
    mcp.run()
