export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
  uptimeSec: number;
  source: 'pidusage' | 'process';
}

export interface ServiceStatus {
  name: string;
  url: string;
  healthy: boolean;
  status: 'ok' | 'down';
  latencyMs: number | null;
  error: string | null;
  version: string | null;
  process: ProcessInfo | null;
}

export interface SystemMetrics {
  hostname: string;
  platform: string;
  arch: string;
  uptime: number;
  loadavg: number[];
  cpu: {
    model: string;
    cores: number;
    usagePerCore: number[];
  };
  memory: {
    total: number;
    free: number;
    used: number;
    usagePercent: number;
  };
  processes: ProcessInfo[];
  timestamp: number;
}

export type ProjectStatus = 'planned' | 'active' | 'blocked' | 'completed';
/** Returned only for projects migrated from the legacy records table. */
export type LegacyProjectStatus = 'archived';
export type ProjectDisplayStatus = ProjectStatus | LegacyProjectStatus;
export type TaskStatus = 'todo' | 'in_progress' | 'done';

export interface Project {
  id: number;
  name: string;
  description: string | null;
  status: ProjectDisplayStatus;
  priority: number;
  owner: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  task_count: number;
  completed_task_count: number;
  progress_percent: number;
}

export interface Task {
  id: number;
  project_id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  assignee: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export type ProjectsPage = Page<Project>;
export type TasksPage = Page<Task>;

export interface ProjectInput {
  name: string;
  description?: string | null;
  status?: ProjectStatus;
  priority?: number;
  owner?: string | null;
  due_date?: string | null;
}

export type ProjectPatch = Partial<ProjectInput>;
export type CreateProjectInput = ProjectInput;
export type UpdateProjectInput = ProjectPatch;

export interface TaskInput {
  title: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: number;
  assignee?: string | null;
  due_date?: string | null;
}

export type TaskPatch = Partial<TaskInput>;
export type CreateTaskInput = TaskInput;
export type UpdateTaskInput = TaskPatch;

export interface ListQuery {
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface ProjectsQuery extends ListQuery {
  /** Read filters also accept the legacy archived status returned by migration. */
  status?: ProjectDisplayStatus;
}

export interface TasksQuery extends ListQuery {
  status?: TaskStatus;
}
