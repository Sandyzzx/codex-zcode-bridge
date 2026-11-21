param([Parameter(Mandatory = $true)][int]$TargetPid)

$ErrorActionPreference = "Stop"

# WMI/CIM process enumeration can stall on loaded Windows runners. Read the
# Toolhelp process snapshot and the target PEB directly instead. This probe is
# test-only and supports the Windows x64 runtime boundary.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public sealed class ProcessTreeRow
{
    public int ProcessId { get; set; }
    public int ParentProcessId { get; set; }
    public string Name { get; set; }
    public string ExecutablePath { get; set; }
    public string CommandLine { get; set; }
}

public static class ProcessTreeProbe
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint PROCESS_VM_READ = 0x0010;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2a;
        public IntPtr Reserved2b;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(
        IntPtr process,
        int flags,
        StringBuilder executablePath,
        ref int size);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr process,
        int processInformationClass,
        ref PROCESS_BASIC_INFORMATION processInformation,
        int processInformationLength,
        out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(
        IntPtr process,
        IntPtr baseAddress,
        byte[] buffer,
        int size,
        out IntPtr bytesRead);

    private static string ReadImagePath(int processId)
    {
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == IntPtr.Zero) return null;
        try
        {
            int size = 32768;
            StringBuilder path = new StringBuilder(size);
            return QueryFullProcessImageName(process, 0, path, ref size) ? path.ToString() : null;
        }
        finally
        {
            CloseHandle(process);
        }
    }

    private static byte[] ReadBytes(IntPtr process, IntPtr address, int size)
    {
        byte[] buffer = new byte[size];
        IntPtr read;
        if (!ReadProcessMemory(process, address, buffer, size, out read) || read.ToInt64() != size)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return buffer;
    }

    private static long ReadInt64(IntPtr process, long address)
    {
        return BitConverter.ToInt64(ReadBytes(process, new IntPtr(address), 8), 0);
    }

    private static string ReadCommandLine(int processId)
    {
        IntPtr process = OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
            false,
            processId);
        if (process == IntPtr.Zero) return null;
        try
        {
            PROCESS_BASIC_INFORMATION basic = new PROCESS_BASIC_INFORMATION();
            int returned;
            if (NtQueryInformationProcess(
                process,
                0,
                ref basic,
                Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)),
                out returned) != 0)
            {
                return null;
            }

            long parameters = ReadInt64(process, basic.PebBaseAddress.ToInt64() + 0x20);
            byte[] unicodeString = ReadBytes(process, new IntPtr(parameters + 0x70), 16);
            ushort length = BitConverter.ToUInt16(unicodeString, 0);
            long buffer = BitConverter.ToInt64(unicodeString, 8);
            if (length == 0 || (int)length > 131070 || buffer == 0) return null;
            return Encoding.Unicode.GetString(ReadBytes(process, new IntPtr(buffer), length));
        }
        catch
        {
            return null;
        }
        finally
        {
            CloseHandle(process);
        }
    }

    public static ProcessTreeRow[] Snapshot(int targetPid)
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            List<ProcessTreeRow> rows = new List<ProcessTreeRow>();
            PROCESSENTRY32 entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32First(snapshot, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());
            do
            {
                int processId = unchecked((int)entry.th32ProcessID);
                int parentProcessId = unchecked((int)entry.th32ParentProcessID);
                if (processId == targetPid || parentProcessId == targetPid)
                {
                    rows.Add(new ProcessTreeRow
                    {
                        ProcessId = processId,
                        ParentProcessId = parentProcessId,
                        Name = entry.szExeFile,
                        ExecutablePath = ReadImagePath(processId),
                        CommandLine = ReadCommandLine(processId)
                    });
                }
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            }
            while (Process32Next(snapshot, ref entry));
            return rows.ToArray();
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }
}
'@

$rows = [ProcessTreeProbe]::Snapshot($TargetPid)
$target = @($rows | Where-Object { $_.ProcessId -eq $TargetPid }) | Select-Object -First 1
$children = @($rows | Where-Object { $_.ParentProcessId -eq $TargetPid })
[ordered]@{
  target = $target
  children = $children
} | ConvertTo-Json -Compress -Depth 4
