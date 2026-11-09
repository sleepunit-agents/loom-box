"""A house's deterministic parent waits for its runtime child before rescue or other finalization."""
import signal
import subprocess
from typing import NamedTuple

class HostResult(NamedTuple):
    code: int
    cancelled: bool


def run_host(argv, *, input=None, **kwargs):
    child = None
    requested = None
    def stop(number, _frame):
        nonlocal requested
        requested = number
        if child is not None and child.poll() is None:
            child.send_signal(number)
    previous = {number: signal.signal(number, stop) for number in (signal.SIGTERM, signal.SIGINT)}
    try:
        if input is not None:
            kwargs['stdin'] = subprocess.PIPE
        child = subprocess.Popen(argv, **kwargs)
        if requested is not None and child.poll() is None:
            child.send_signal(requested)
        child.communicate(input)
        code = child.returncode
        # Only a requested, recognizable cancellation is an intentional house stop. Failures stay failures.
        cancelled = requested is not None and code in (0, 130, 143, -signal.SIGTERM, -signal.SIGINT)
        return HostResult(code, cancelled)
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
