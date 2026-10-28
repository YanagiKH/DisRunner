"""Deliver a real Ctrl+C to one test-owned CLI in an isolated Windows console.

The controller joins its own kill-on-close Job before spawning Node. A successful
receipt requires an empty child tree before that containment is disarmed.
Only Python's standard library is used; CI supplies the pinned interpreter.
"""

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def main():
    if sys.platform != "win32":
        raise RuntimeError("This controller requires Windows.")
    directory = Path(sys.argv[1])
    command = json.loads((directory / "arguments.json").read_text(encoding="utf-8"))
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    size_t = ctypes.c_size_t

    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("process_time", ctypes.c_longlong),
            ("job_time", ctypes.c_longlong),
            ("flags", wintypes.DWORD),
            ("min_working_set", size_t),
            ("max_working_set", size_t),
            ("active_process_limit", wintypes.DWORD),
            ("affinity", size_t),
            ("priority", wintypes.DWORD),
            ("scheduling", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            "read_operations", "write_operations", "other_operations",
            "read_bytes", "write_bytes", "other_bytes",
        )]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("basic", BasicLimits), ("io", IoCounters),
            ("process_memory", size_t), ("job_memory", size_t),
            ("peak_process_memory", size_t), ("peak_job_memory", size_t),
        ]

    class Accounting(ctypes.Structure):
        _fields_ = [
            ("user_time", ctypes.c_longlong), ("kernel_time", ctypes.c_longlong),
            ("period_user_time", ctypes.c_longlong), ("period_kernel_time", ctypes.c_longlong),
            ("page_faults", wintypes.DWORD), ("total_processes", wintypes.DWORD),
            ("active_processes", wintypes.DWORD), ("terminated_processes", wintypes.DWORD),
        ]

    handler_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)
    signatures = {
        "AllocConsole": ([], wintypes.BOOL),
        "FreeConsole": ([], wintypes.BOOL),
        "SetConsoleCtrlHandler": ([ctypes.c_void_p, wintypes.BOOL], wintypes.BOOL),
        "GenerateConsoleCtrlEvent": ([wintypes.DWORD, wintypes.DWORD], wintypes.BOOL),
        "GetConsoleProcessList": ([ctypes.POINTER(wintypes.DWORD), wintypes.DWORD], wintypes.DWORD),
        "CreateJobObjectW": ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
        "SetInformationJobObject": ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
        "AssignProcessToJobObject": ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
        "QueryInformationJobObject": ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p], wintypes.BOOL),
        "GetCurrentProcess": ([], wintypes.HANDLE),
        "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
    }
    for name, (args, result) in signatures.items():
        function = getattr(kernel, name)
        function.argtypes = args
        function.restype = result

    def checked(result):
        if not result:
            raise ctypes.WinError(ctypes.get_last_error())
        return result

    report = {
        "controllerPid": os.getpid(), "cliPid": None, "eventDelivered": False,
        "consoleClients": [], "remainingProcessIds": [], "exitCode": None,
        "activeProcesses": None, "containmentDisarmed": False, "error": None,
    }
    job = None
    passed = False
    try:
        # AllocConsole succeeding after this detach is the isolation boundary.
        kernel.FreeConsole()
        checked(kernel.AllocConsole())
        checked(kernel.SetConsoleCtrlHandler(None, False))
        # Function handlers are not inherited. Do not set the inheritable ignore flag.
        handler = handler_type(lambda event: event == 0)
        checked(kernel.SetConsoleCtrlHandler(handler, True))

        job = checked(kernel.CreateJobObjectW(None, None))
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        checked(kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
        checked(kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()))

        # Explicit files avoid AllocConsole changing the controller's standard handles.
        with (directory / "stdout.txt").open("wb") as stdout, (directory / "stderr.txt").open("wb") as stderr:
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout,
                                     stderr=stderr, close_fds=True, creationflags=0)
            report["cliPid"] = child.pid
            (directory / "ready.json").write_text(json.dumps({"cliPid": child.pid}), encoding="utf-8")
            deadline = time.monotonic() + 10
            while child.poll() is None:
                if (directory / "abort").exists():
                    raise RuntimeError("Test aborted; owned Job containment remains armed.")
                if time.monotonic() >= deadline:
                    raise TimeoutError("The CLI did not exit within the controller deadline.")
                if not report["eventDelivered"] and (directory / "interrupt").exists():
                    clients = (wintypes.DWORD * 64)()
                    count = checked(kernel.GetConsoleProcessList(clients, len(clients)))
                    if count > len(clients):
                        raise RuntimeError("Console process list overflowed.")
                    report["consoleClients"] = sorted(clients[:count])
                    if set(clients[:count]) != {os.getpid(), child.pid}:
                        raise RuntimeError("The private console has unexpected attached clients.")
                    checked(kernel.GenerateConsoleCtrlEvent(0, 0))  # CTRL_C_EVENT
                    report["eventDelivered"] = True
                time.sleep(0.01)
            report["exitCode"] = child.wait()
            # CPython keeps this owned process HANDLE after wait(). Release its
            # terminal reference before querying the Job's active process list.
            child._handle.Close()

        # Inspect the still-armed Job before any fallback can hide a leaked Bot/helper.
        processes = ctypes.create_string_buffer(65536)
        checked(kernel.QueryInformationJobObject(job, 3, processes, len(processes), None))
        assigned, count = ctypes.cast(processes, ctypes.POINTER(wintypes.DWORD))[:2]
        if count > (len(processes) - 8) // ctypes.sizeof(size_t) or assigned != count:
            raise RuntimeError("Incomplete Job process observation.")
        ids = ctypes.cast(ctypes.addressof(processes) + 8, ctypes.POINTER(size_t))[:count]
        report["remainingProcessIds"] = sorted(pid for pid in ids if pid != os.getpid())
        if report["remainingProcessIds"]:
            raise RuntimeError("The CLI returned before its owned process tree terminated.")
        accounting = Accounting()
        checked(kernel.QueryInformationJobObject(job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None))
        report["activeProcesses"] = accounting.active_processes
        if accounting.active_processes != 1 or ids != [os.getpid()]:
            raise RuntimeError("The controller is not the only active Job process.")
        if not report["eventDelivered"]:
            raise RuntimeError("The CLI exited without receiving the requested Ctrl+C.")

        # Only the controller remains; no child can be silently cleaned up on success.
        limits.basic.flags = 0
        checked(kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
        checked(kernel.CloseHandle(job))
        job = None
        report["containmentDisarmed"] = True
        passed = True
    except BaseException as error:
        report["error"] = f"{type(error).__name__}: {error}"
    finally:
        (directory / "receipt.json").write_text(json.dumps(report), encoding="utf-8")
        if job is not None:
            # Includes the controller; close only after the failed receipt is durable.
            kernel.CloseHandle(job)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
