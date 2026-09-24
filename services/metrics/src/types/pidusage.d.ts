declare module 'pidusage' {
  export interface PidUsageStat {
    pid: number;
    ppid: number;
    /** CPU usage percent */
    cpu: number;
    /** Memory usage in bytes */
    memory: number;
    /** Process creation time (ms) */
    ctime: number;
    /** Elapsed time since process start (ms) */
    elapsed: number;
    timestamp: number;
  }
  export default function pidusage(pid: number | number[]): Promise<PidUsageStat>;
}