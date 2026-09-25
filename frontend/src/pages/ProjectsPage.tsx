import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import type {
  CreateProjectInput,
  CreateTaskInput,
  Project,
  ProjectInput,
  ProjectsQuery,
  ProjectStatus,
  ProjectDisplayStatus,
  Task,
  TaskInput,
  TaskStatus,
} from '../types';

export const PROJECT_STATUSES: ProjectStatus[] = ['planned', 'active', 'blocked', 'completed'];
const PROJECT_FILTER_STATUSES: ProjectDisplayStatus[] = [...PROJECT_STATUSES, 'archived'];
export const TASK_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'done'];

const PROJECT_STATUS_LABELS: Record<ProjectDisplayStatus, string> = {
  planned: 'Запланований',
  active: 'Активний',
  blocked: 'Заблокований',
  completed: 'Завершений',
  archived: 'Архівований (стара система)',
};

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'До початку',
  in_progress: 'У роботі',
  done: 'Виконано',
};

const PRIORITY_VALUES = [1, 2, 3, 4, 5];

const EMPTY_PROJECT_FORM: ProjectInput = {
  name: '',
  description: '',
  status: 'planned',
  priority: 3,
  owner: '',
  due_date: '',
};

const EMPTY_TASK_FORM: TaskInput = {
  title: '',
  description: '',
  status: 'todo',
  priority: 3,
  assignee: '',
  due_date: '',
};

function newProjectForm(): ProjectInput {
  return { ...EMPTY_PROJECT_FORM };
}

function newTaskForm(): TaskInput {
  return { ...EMPTY_TASK_FORM };
}

const PROJECT_PAGE_SIZE = 100;
const TASK_PAGE_SIZE = 200;

async function fetchAllProjects(query: ProjectsQuery): Promise<{ items: Project[]; total: number }> {
  const first = await api.projects({ ...query, limit: PROJECT_PAGE_SIZE, offset: 0 });
  const items = Array.isArray(first.items) ? [...first.items] : [];
  const total = Number.isFinite(first.total) ? first.total : items.length;
  let offset = items.length;

  while (offset < total) {
    const page = await api.projects({ ...query, limit: PROJECT_PAGE_SIZE, offset });
    const pageItems = Array.isArray(page.items) ? page.items : [];
    if (pageItems.length === 0) {
      throw new Error('Пагінація повернула порожню сторінку до заявленої кількості записів.');
    }
    items.push(...pageItems);
    offset += pageItems.length;
  }

  return { items, total };
}

async function fetchAllTasks(projectId: number): Promise<Task[]> {
  const first = await api.projectTasks(projectId, { limit: TASK_PAGE_SIZE, offset: 0 });
  const items = Array.isArray(first.items) ? [...first.items] : [];
  const total = Number.isFinite(first.total) ? first.total : items.length;
  let offset = items.length;

  while (offset < total) {
    const page = await api.projectTasks(projectId, { limit: TASK_PAGE_SIZE, offset });
    const pageItems = Array.isArray(page.items) ? page.items : [];
    if (pageItems.length === 0) {
      throw new Error('Пагінація повернула порожню сторінку до заявленої кількості задач.');
    }
    items.push(...pageItems);
    offset += pageItems.length;
  }

  return items;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safePercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (dateOnly) return `${dateOnly[3]}.${dateOnly[2]}.${dateOnly[1]}`;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('uk-UA');
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('uk-UA');
}

function toDateInputValue(value: string | null | undefined): string {
  if (!value) return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1] ?? '';
}

function normalizePriority(value: number | undefined): number {
  const priority = Math.round(Number(value));
  if (!Number.isFinite(priority)) return 3;
  return Math.max(1, Math.min(5, priority));
}

function projectPayload(form: ProjectInput): CreateProjectInput {
  return {
    name: form.name.trim(),
    description: form.description?.trim() || null,
    status: form.status ?? 'planned',
    priority: normalizePriority(form.priority),
    owner: form.owner?.trim() || null,
    due_date: form.due_date || null,
  };
}

function taskPayload(form: TaskInput): CreateTaskInput {
  return {
    title: form.title.trim(),
    description: form.description?.trim() || null,
    status: form.status ?? 'todo',
    priority: normalizePriority(form.priority),
    assignee: form.assignee?.trim() || null,
    due_date: form.due_date || null,
  };
}

function projectToForm(project: Project): ProjectInput {
  return {
    name: project.name,
    description: project.description ?? '',
    // `archived` is legacy/read-only; the editor is only opened for writable
    // statuses. Keep a safe fallback for defensive rendering of old API data.
    status: project.status === 'archived' ? 'completed' : project.status,
    priority: project.priority,
    owner: project.owner ?? '',
    due_date: toDateInputValue(project.due_date),
  };
}

function taskToForm(task: Task): TaskInput {
  return {
    title: task.title,
    description: task.description ?? '',
    status: task.status,
    priority: task.priority,
    assignee: task.assignee ?? '',
    due_date: toDateInputValue(task.due_date),
  };
}

/** Calculates project progress from the tasks currently loaded for that project. */
export function calculateProjectProgress(tasks: Task[]): number {
  if (tasks.length === 0) return 0;
  const completed = tasks.filter((task) => task.status === 'done').length;
  return Math.round((completed / tasks.length) * 100);
}

function projectWithTaskCounts(project: Project, tasks: Task[]): Project {
  const completedTaskCount = tasks.filter((task) => task.status === 'done').length;
  return {
    ...project,
    task_count: tasks.length,
    completed_task_count: completedTaskCount,
    progress_percent: calculateProjectProgress(tasks),
  };
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  const percent = safePercent(value);
  return (
    <div
      className="progress-track"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
    >
      <div className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

function ProjectStatusBadge({ status }: { status: ProjectDisplayStatus }) {
  return <span className={`badge project-badge-${status}`}>{PROJECT_STATUS_LABELS[status]}</span>;
}

function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`badge task-badge-${status}`}>{TASK_STATUS_LABELS[status]}</span>;
}

interface ProjectFormProps {
  form: ProjectInput;
  editing: boolean;
  readOnly?: boolean;
  busy: boolean;
  onChange: (form: ProjectInput) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}

function ProjectForm({
  form,
  editing,
  readOnly = false,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: ProjectFormProps) {
  if (readOnly) {
    return (
      <div className="project-form project-form-readonly">
        <div className="section-heading form-section-heading">
          <div>
            <h2>Legacy-проєкт</h2>
            <p className="muted">
              Цей запис збережено під час міграції зі статусом «Архівований» і не можна
              редагувати через поточний CRUD API.
            </p>
          </div>
        </div>
        <div className="form-actions">
          <button className="btn ghost" type="button" onClick={onCancel} disabled={busy}>
            Закрити
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="project-form" onSubmit={onSubmit}>
      <div className="section-heading form-section-heading">
        <div>
          <h2>{editing ? 'Редагувати проєкт' : 'Новий проєкт'}</h2>
          <p className="muted">
            {editing ? 'Змініть дані проєкту та збережіть їх.' : 'Заповніть основні дані, щоб додати проєкт.'}
          </p>
        </div>
      </div>
      <div className="form-grid project-form-grid">
        <div className="form-field form-field-wide">
          <label htmlFor="project-name">Назва *</label>
          <input
            id="project-name"
            name="name"
            className="input"
            value={form.name}
            onChange={(event) => onChange({ ...form, name: event.target.value })}
            placeholder="Наприклад, онбординг команди"
            required
            maxLength={160}
          />
        </div>
        <div className="form-field form-field-wide">
          <label htmlFor="project-description">Опис</label>
          <textarea
            id="project-description"
            name="description"
            className="input"
            rows={3}
            value={form.description ?? ''}
            onChange={(event) => onChange({ ...form, description: event.target.value })}
            placeholder="Коротко опишіть мету та результат"
            maxLength={2000}
          />
        </div>
        <div className="form-field">
          <label htmlFor="project-status">Статус</label>
          <select
            id="project-status"
            name="status"
            className="input"
            value={form.status ?? 'planned'}
            onChange={(event) =>
              onChange({ ...form, status: event.target.value as ProjectStatus })
            }
          >
            {PROJECT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {PROJECT_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="project-priority">Пріоритет</label>
          <select
            id="project-priority"
            name="priority"
            className="input"
            value={form.priority ?? 3}
            onChange={(event) => onChange({ ...form, priority: Number(event.target.value) })}
          >
            {PRIORITY_VALUES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="project-owner">Відповідальний</label>
          <input
            id="project-owner"
            name="owner"
            className="input"
            value={form.owner ?? ''}
            onChange={(event) => onChange({ ...form, owner: event.target.value })}
            placeholder="Ім'я або команда"
          />
        </div>
        <div className="form-field">
          <label htmlFor="project-due-date">Термін виконання</label>
          <input
            id="project-due-date"
            name="due_date"
            className="input"
            type="date"
            value={form.due_date ?? ''}
            onChange={(event) => onChange({ ...form, due_date: event.target.value })}
          />
        </div>
      </div>
      <div className="form-actions">
        {editing && (
          <button className="btn ghost" type="button" onClick={onCancel} disabled={busy}>
            Скасувати
          </button>
        )}
        <button className="btn primary" type="submit" disabled={busy || !form.name.trim()}>
          {busy ? 'Збереження…' : editing ? 'Зберегти зміни' : 'Створити проєкт'}
        </button>
      </div>
    </form>
  );
}

interface TaskFormProps {
  form: TaskInput;
  editing: boolean;
  busy: boolean;
  onChange: (form: TaskInput) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}

function TaskForm({ form, editing, busy, onChange, onSubmit, onCancel }: TaskFormProps) {
  return (
    <form className="task-form" onSubmit={onSubmit}>
      <div className="section-heading form-section-heading">
        <div>
          <h3>{editing ? 'Редагувати задачу' : 'Додати задачу'}</h3>
          <p className="muted">
            {editing ? 'Оновіть опис, пріоритет або виконавця.' : 'Розбийте проєкт на конкретні кроки.'}
          </p>
        </div>
      </div>
      <div className="form-grid task-form-grid">
        <div className="form-field form-field-wide">
          <label htmlFor="task-title">Назва задачі *</label>
          <input
            id="task-title"
            name="title"
            className="input"
            value={form.title}
            onChange={(event) => onChange({ ...form, title: event.target.value })}
            placeholder="Що потрібно зробити?"
            required
            maxLength={160}
          />
        </div>
        <div className="form-field form-field-wide">
          <label htmlFor="task-description">Опис</label>
          <textarea
            id="task-description"
            name="description"
            className="input"
            rows={2}
            value={form.description ?? ''}
            onChange={(event) => onChange({ ...form, description: event.target.value })}
            placeholder="Деталі задачі"
            maxLength={2000}
          />
        </div>
        <div className="form-field">
          <label htmlFor="task-status">Статус</label>
          <select
            id="task-status"
            name="status"
            className="input"
            value={form.status ?? 'todo'}
            onChange={(event) => onChange({ ...form, status: event.target.value as TaskStatus })}
          >
            {TASK_STATUSES.map((status) => (
              <option key={status} value={status}>
                {TASK_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="task-priority">Пріоритет</label>
          <select
            id="task-priority"
            name="priority"
            className="input"
            value={form.priority ?? 3}
            onChange={(event) => onChange({ ...form, priority: Number(event.target.value) })}
          >
            {PRIORITY_VALUES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="task-assignee">Виконавець</label>
          <input
            id="task-assignee"
            name="assignee"
            className="input"
            value={form.assignee ?? ''}
            onChange={(event) => onChange({ ...form, assignee: event.target.value })}
            placeholder="Ім'я або команда"
          />
        </div>
        <div className="form-field">
          <label htmlFor="task-due-date">Термін</label>
          <input
            id="task-due-date"
            name="due_date"
            className="input"
            type="date"
            value={form.due_date ?? ''}
            onChange={(event) => onChange({ ...form, due_date: event.target.value })}
          />
        </div>
      </div>
      <div className="form-actions">
        {editing && (
          <button className="btn ghost" type="button" onClick={onCancel} disabled={busy}>
            Скасувати
          </button>
        )}
        <button className="btn primary" type="submit" disabled={busy || !form.title.trim()}>
          {busy ? 'Збереження…' : editing ? 'Зберегти задачу' : 'Додати задачу'}
        </button>
      </div>
    </form>
  );
}

interface ProjectListItemProps {
  project: Project;
  selected: boolean;
  onSelect: (id: number) => void;
}

function ProjectListItem({ project, selected, onSelect }: ProjectListItemProps) {
  return (
    <button
      type="button"
      className={`project-list-item${selected ? ' selected' : ''}`}
      onClick={() => onSelect(project.id)}
      aria-pressed={selected}
    >
      <div className="project-item-top">
        <span className="project-item-name">{project.name}</span>
        <ProjectStatusBadge status={project.status} />
      </div>
      <p className="project-item-description">{project.description || 'Без опису'}</p>
      <div className="project-item-progress">
        <div className="project-item-progress-label">
          <span>Прогрес</span>
          <strong>{Math.round(safePercent(project.progress_percent))}%</strong>
        </div>
        <ProgressBar value={project.progress_percent} label={`Прогрес проєкту ${project.name}`} />
      </div>
      <div className="project-item-footer">
        <span>{project.task_count} задач</span>
        <span>Термін: {formatDate(project.due_date)}</span>
      </div>
    </button>
  );
}

interface TaskCardProps {
  task: Task;
  editing: boolean;
  readOnly?: boolean;
  draft: TaskInput;
  busy: boolean;
  onStartEdit: () => void;
  onDraftChange: (form: TaskInput) => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  onDelete: () => void;
  onStatusChange: (status: TaskStatus) => void;
}

function TaskCard({
  task,
  editing,
  readOnly = false,
  draft,
  busy,
  onStartEdit,
  onDraftChange,
  onSave,
  onCancel,
  onDelete,
  onStatusChange,
}: TaskCardProps) {
  if (editing && !readOnly) {
    return (
      <article className="task-card task-card-editing">
        <form className="task-edit-form" onSubmit={onSave}>
          <div className="form-grid task-edit-grid">
            <div className="form-field form-field-wide">
              <label htmlFor={`edit-task-title-${task.id}`}>Назва задачі *</label>
              <input
                id={`edit-task-title-${task.id}`}
                className="input"
                value={draft.title}
                onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
                required
                maxLength={160}
              />
            </div>
            <div className="form-field form-field-wide">
              <label htmlFor={`edit-task-description-${task.id}`}>Опис</label>
              <textarea
                id={`edit-task-description-${task.id}`}
                className="input"
                rows={2}
                value={draft.description ?? ''}
                onChange={(event) => onDraftChange({ ...draft, description: event.target.value })}
                maxLength={2000}
              />
            </div>
            <div className="form-field">
              <label htmlFor={`edit-task-status-${task.id}`}>Статус</label>
              <select
                id={`edit-task-status-${task.id}`}
                className="input"
                value={draft.status ?? 'todo'}
                onChange={(event) =>
                  onDraftChange({ ...draft, status: event.target.value as TaskStatus })
                }
              >
                {TASK_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {TASK_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={`edit-task-priority-${task.id}`}>Пріоритет</label>
              <select
                id={`edit-task-priority-${task.id}`}
                className="input"
                value={draft.priority ?? 3}
                onChange={(event) =>
                  onDraftChange({ ...draft, priority: Number(event.target.value) })
                }
              >
                {PRIORITY_VALUES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={`edit-task-assignee-${task.id}`}>Виконавець</label>
              <input
                id={`edit-task-assignee-${task.id}`}
                className="input"
                value={draft.assignee ?? ''}
                onChange={(event) => onDraftChange({ ...draft, assignee: event.target.value })}
              />
            </div>
            <div className="form-field">
              <label htmlFor={`edit-task-due-date-${task.id}`}>Термін</label>
              <input
                id={`edit-task-due-date-${task.id}`}
                className="input"
                type="date"
                value={draft.due_date ?? ''}
                onChange={(event) => onDraftChange({ ...draft, due_date: event.target.value })}
              />
            </div>
          </div>
          <div className="task-card-actions">
            <button className="btn small" type="submit" disabled={busy || !draft.title.trim()}>
              Зберегти
            </button>
            <button className="btn small ghost" type="button" onClick={onCancel} disabled={busy}>
              Скасувати
            </button>
            <button className="btn small danger" type="button" onClick={onDelete} disabled={busy}>
              Видалити
            </button>
          </div>
        </form>
      </article>
    );
  }

  return (
    <article className={`task-card task-card-${task.status}`}>
      <div className="task-card-header">
        <div className="task-card-heading">
          <h4>{task.title}</h4>
          {task.description && <p>{task.description}</p>}
        </div>
        <TaskStatusBadge status={task.status} />
      </div>
      <div className="task-card-details">
        <span>Пріоритет: <b>{task.priority}</b></span>
        <span>Виконавець: {task.assignee || 'не призначено'}</span>
        <span>Термін: {formatDate(task.due_date)}</span>
      </div>
      {!readOnly && (
        <div className="task-card-actions">
          <label className="task-status-control">
            <span className="sr-only">Змінити статус задачі {task.title}</span>
            <select
              className="input task-status-select"
              value={task.status}
              onChange={(event) => onStatusChange(event.target.value as TaskStatus)}
              disabled={busy}
              aria-label={`Статус задачі ${task.title}`}
            >
              {TASK_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {TASK_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>
          <button className="btn small" type="button" onClick={onStartEdit} disabled={busy}>
            Редагувати
          </button>
          <button className="btn small danger" type="button" onClick={onDelete} disabled={busy}>
            Видалити
          </button>
        </div>
      )}
    </article>
  );
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectTotal, setProjectTotal] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProjectDisplayStatus | ''>('');
  const debouncedSearch = useDebouncedValue(search, 350);

  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [projectForm, setProjectForm] = useState<ProjectInput>(newProjectForm);
  const [editingProjectId, setEditingProjectId] = useState<number | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskForm, setTaskForm] = useState<TaskInput>(newTaskForm);
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [taskDraft, setTaskDraft] = useState<TaskInput>(newTaskForm);
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskActionId, setTaskActionId] = useState<number | null>(null);
  const detailRequestRef = useRef(0);

  const loadProjects = useCallback(async () => {
    setListLoading(true);
    try {
      const page = await fetchAllProjects({
        search: debouncedSearch || undefined,
        status: statusFilter || undefined,
      });
      setProjects(page.items);
      setProjectTotal(page.total);
      setListError(null);
    } catch (error) {
      setListError(errorMessage(error));
    } finally {
      setListLoading(false);
    }
  }, [debouncedSearch, statusFilter]);

  const loadProjectDetails = useCallback(async (projectId: number) => {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    setDetailLoading(true);
    setDetailError(null);
    setTaskError(null);
    setSelectedProject(null);
    setTasks([]);
    setTasksLoaded(false);

    try {
      const [projectResult, taskResult] = await Promise.allSettled([
        api.project(projectId),
        fetchAllTasks(projectId),
      ]);
      if (requestId !== detailRequestRef.current) return;

      if (projectResult.status === 'fulfilled') {
        setSelectedProject(projectResult.value);
      } else {
        setDetailError(errorMessage(projectResult.reason));
      }

      if (taskResult.status === 'fulfilled') {
        const taskItems = Array.isArray(taskResult.value) ? taskResult.value : [];
        setTasks(taskItems);
        setTasksLoaded(true);
      } else {
        setTasksLoaded(true);
        setTaskError(errorMessage(taskResult.reason));
      }
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (projects.length === 0) {
      if (!listLoading && selectedProjectId !== null) setSelectedProjectId(null);
      return;
    }
    if (selectedProjectId === null || !projects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(projects[0].id);
    }
  }, [listLoading, projects, selectedProjectId]);

  useEffect(() => {
    setEditingProjectId(null);
    setProjectForm(newProjectForm());
  }, [selectedProjectId]);

  useEffect(() => {
    if (selectedProjectId === null) {
      detailRequestRef.current += 1;
      setSelectedProject(null);
      setTasks([]);
      setTasksLoaded(false);
      setDetailLoading(false);
      setDetailError(null);
      setTaskError(null);
      setEditingTaskId(null);
      setTaskDraft(newTaskForm());
      return;
    }

    setEditingTaskId(null);
    setTaskDraft(newTaskForm());
    void loadProjectDetails(selectedProjectId);
  }, [loadProjectDetails, selectedProjectId]);

  const summary = useMemo(() => {
    const active = projects.filter((project) => project.status === 'active').length;
    const blocked = projects.filter((project) => project.status === 'blocked').length;
    const completedTasks = projects.reduce(
      (sum, project) => sum + (Number.isFinite(project.completed_task_count) ? project.completed_task_count : 0),
      0,
    );
    const averageProgress =
      projects.length === 0
        ? 0
        : projects.reduce((sum, project) => sum + safePercent(project.progress_percent), 0) /
          projects.length;
    return { active, blocked, completedTasks, averageProgress };
  }, [projects]);

  const progress = tasksLoaded ? calculateProjectProgress(tasks) : 0;
  const completedTaskCount = tasks.filter((task) => task.status === 'done').length;

  function startProjectEdit(project: Project) {
    if (project.status === 'archived') {
      setActionError('Legacy-архівований проєкт доступний лише для перегляду.');
      return;
    }
    setEditingProjectId(project.id);
    setProjectForm(projectToForm(project));
    setActionError(null);
  }

  function cancelProjectEdit() {
    setEditingProjectId(null);
    setProjectForm(newProjectForm());
    setActionError(null);
  }

  async function handleProjectSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (projectBusy || !projectForm.name.trim()) return;
    if (editingProjectId !== null && selectedProject?.status === 'archived') {
      setEditingProjectId(null);
      setProjectForm(newProjectForm());
      return;
    }

    setProjectBusy(true);
    setActionError(null);
    try {
      const input = projectPayload(projectForm);
      let savedProjectId: number;
      if (editingProjectId === null) {
        const created = await api.createProject(input);
        savedProjectId = created.id;
        setSelectedProjectId(savedProjectId);
        setSelectedProject(created);
      } else {
        const updated = await api.updateProject(editingProjectId, input);
        savedProjectId = updated.id;
        setSelectedProject(updated);
        setEditingProjectId(null);
      }
      setProjectForm(newProjectForm());
      await loadProjectDetails(savedProjectId);
      await loadProjects();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setProjectBusy(false);
    }
  }

  async function handleProjectDelete(project: Project) {
    if (project.status === 'archived') {
      setActionError('Legacy-архівований проєкт доступний лише для перегляду.');
      return;
    }
    if (
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function' &&
      !window.confirm(`Видалити проєкт «${project.name}»?`)
    ) {
      return;
    }

    setProjectBusy(true);
    setActionError(null);
    try {
      await api.deleteProject(project.id);
      if (editingProjectId === project.id) cancelProjectEdit();
      if (selectedProjectId === project.id) setSelectedProjectId(null);
      await loadProjects();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setProjectBusy(false);
    }
  }

  async function handleTaskSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = editingTaskId === null ? taskForm : taskDraft;
    if (selectedProject?.status === 'archived') {
      setTaskError('Legacy-архівований проєкт доступний лише для перегляду.');
      return;
    }
    if (taskBusy || selectedProjectId === null || !form.title.trim()) return;

    setTaskBusy(true);
    setTaskError(null);
    try {
      const input = taskPayload(form);
      if (editingTaskId === null) {
        await api.createTask(selectedProjectId, input);
      } else {
        await api.updateTask(editingTaskId, input);
      }
      setEditingTaskId(null);
      setTaskDraft(newTaskForm());
      setTaskForm(newTaskForm());
      await loadProjectDetails(selectedProjectId);
      await loadProjects();
    } catch (error) {
      setTaskError(errorMessage(error));
    } finally {
      setTaskBusy(false);
    }
  }

  function startTaskEdit(task: Task) {
    if (selectedProject?.status === 'archived') {
      setTaskError('Legacy-архівований проєкт доступний лише для перегляду.');
      return;
    }
    setEditingTaskId(task.id);
    setTaskDraft(taskToForm(task));
    setTaskError(null);
  }

  function cancelTaskEdit() {
    setEditingTaskId(null);
    setTaskDraft(newTaskForm());
  }

  async function handleTaskStatusChange(task: Task, status: TaskStatus) {
    if (selectedProject?.status === 'archived') {
      setTaskError('Legacy-архівований проєкт доступний лише для перегляду.');
      return;
    }
    if (taskBusy || task.status === status) return;

    setTaskBusy(true);
    setTaskActionId(task.id);
    setTaskError(null);
    try {
      const updated = await api.updateTask(task.id, { status });
      const nextTasks = tasks.map((item) => (item.id === task.id ? updated : item));
      setTasks(nextTasks);
      setSelectedProject((project) =>
        project ? projectWithTaskCounts(project, nextTasks) : project,
      );
      await loadProjects();
    } catch (error) {
      setTaskError(errorMessage(error));
    } finally {
      setTaskActionId(null);
      setTaskBusy(false);
    }
  }

  async function handleTaskDelete(task: Task) {
    if (selectedProject?.status === 'archived') {
      setTaskError('Legacy-архівований проєкт доступний лише для перегляду.');
      return;
    }
    if (
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function' &&
      !window.confirm(`Видалити задачу «${task.title}»?`)
    ) {
      return;
    }
    if (taskBusy) return;

    setTaskBusy(true);
    setTaskActionId(task.id);
    setTaskError(null);
    try {
      await api.deleteTask(task.id);
      const nextTasks = tasks.filter((item) => item.id !== task.id);
      setTasks(nextTasks);
      setSelectedProject((project) =>
        project ? projectWithTaskCounts(project, nextTasks) : project,
      );
      if (editingTaskId === task.id) cancelTaskEdit();
      await loadProjects();
    } catch (error) {
      setTaskError(errorMessage(error));
    } finally {
      setTaskActionId(null);
      setTaskBusy(false);
    }
  }

  return (
    <div className="projects-page">
      <header className="page-head">
        <h1>Проєкти</h1>
        <p className="muted">
          Плануйте роботу, розподіляйте задачі та відстежуйте прогрес у реальному часі.
        </p>
      </header>

      <section className="cards compact project-summary" aria-label="Підсумки проєктів">
        <div className="card stat">
          <div className="muted">Всього проєктів</div>
          <div className="stat-value">{projectTotal}</div>
          <div className="muted">За обраними фільтрами</div>
        </div>
        <div className="card stat">
          <div className="muted">Активні</div>
          <div className="stat-value project-stat-active">{summary.active}</div>
          <div className="muted">Проєкти у роботі</div>
        </div>
        <div className="card stat">
          <div className="muted">Заблоковані</div>
          <div className="stat-value project-stat-blocked">{summary.blocked}</div>
          <div className="muted">Потребують уваги</div>
        </div>
        <div className="card stat">
          <div className="muted">Середній прогрес</div>
          <div className="stat-value">{Math.round(summary.averageProgress)}%</div>
          <div className="muted">Виконано задач: {summary.completedTasks}</div>
        </div>
      </section>

      {listError && (
        <div className="banner error" role="alert">
          ⚠️ Не вдалося завантажити проєкти: {listError}
        </div>
      )}
      {actionError && (
        <div className="banner error" role="alert">
          ⚠️ {actionError}
        </div>
      )}

      <section className="card form-card project-create-card">
        <ProjectForm
          form={projectForm}
          editing={editingProjectId !== null}
          readOnly={editingProjectId !== null && selectedProject?.status === 'archived'}
          busy={projectBusy}
          onChange={setProjectForm}
          onSubmit={(event) => void handleProjectSubmit(event)}
          onCancel={cancelProjectEdit}
        />
      </section>

      <div className="projects-layout">
        <section className="card project-list-panel" aria-labelledby="project-list-title">
          <div className="panel-heading">
            <div>
              <h2 id="project-list-title">Список проєктів</h2>
              <p className="muted">Оберіть проєкт, щоб переглянути його задачі</p>
            </div>
            <button
              className="btn small ghost"
              type="button"
              onClick={() => void loadProjects()}
              disabled={listLoading}
              aria-label="Оновити список проєктів"
            >
              {listLoading ? 'Оновлення…' : 'Оновити'}
            </button>
          </div>

          <div className="project-filters">
            <label className="filter-field">
              <span className="sr-only">Пошук проєктів</span>
              <input
                className="input"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Пошук за назвою…"
                aria-label="Пошук проєктів"
              />
            </label>
            <label className="filter-field">
              <span className="sr-only">Фільтр за статусом</span>
              <select
                className="input"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as ProjectDisplayStatus | '')}
                aria-label="Фільтр за статусом проєкту"
              >
                <option value="">Усі статуси</option>
                {PROJECT_FILTER_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {PROJECT_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {listLoading && projects.length > 0 && (
            <div className="inline-status" role="status">
              Оновлення списку…
            </div>
          )}

          {projects.length > 0 ? (
            <div className="project-list">
              {projects.map((project) => (
                <ProjectListItem
                  key={project.id}
                  project={project}
                  selected={project.id === selectedProjectId}
                  onSelect={(id) => {
                    setActionError(null);
                    setSelectedProjectId(id);
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="empty-state">
              {listLoading ? (
                <>
                  <div className="empty-state-icon">⏳</div>
                  <strong>Завантаження проєктів…</strong>
                </>
              ) : listError ? (
                <>
                  <div className="empty-state-icon">⚠️</div>
                  <strong>Список проєктів недоступний</strong>
                  <span>Спробуйте оновити запит або перевірте з’єднання з API.</span>
                </>
              ) : (
                <>
                  <div className="empty-state-icon">📁</div>
                  <strong>{search || statusFilter ? 'Проєктів не знайдено' : 'Проєктів поки немає'}</strong>
                  <span>
                    {search || statusFilter
                      ? 'Змініть пошук або фільтр статусу.'
                      : 'Створіть перший проєкт, щоб почати планування.'}
                  </span>
                </>
              )}
            </div>
          )}
        </section>

        <section className="card project-detail" aria-labelledby="project-detail-title">
          {selectedProject ? (
            <>
              {detailError && (
                <div className="banner error" role="alert">
                  ⚠️ {detailError}
                </div>
              )}
              {detailLoading && (
                <div className="inline-status" role="status">
                  Оновлення деталей проєкту…
                </div>
              )}

              <div className="detail-header">
                <div className="detail-title-block">
                  <div className="eyebrow">Деталі проєкту</div>
                  <h2 id="project-detail-title">{selectedProject.name}</h2>
                  <div className="detail-badges">
                    <ProjectStatusBadge status={selectedProject.status} />
                    <span className="badge priority-badge">Пріоритет {selectedProject.priority}</span>
                  </div>
                </div>
                <div className="detail-actions">
                  <button
                    className="btn small"
                    type="button"
                    onClick={() => startProjectEdit(selectedProject)}
                    disabled={projectBusy || selectedProject.status === 'archived'}
                    title={selectedProject.status === 'archived' ? 'Legacy-проєкт доступний лише для перегляду' : undefined}
                  >
                    Редагувати
                  </button>
                  <button
                    className="btn small danger"
                    type="button"
                    onClick={() => void handleProjectDelete(selectedProject)}
                    disabled={projectBusy || selectedProject.status === 'archived'}
                    title={selectedProject.status === 'archived' ? 'Legacy-проєкт доступний лише для перегляду' : undefined}
                  >
                    Видалити
                  </button>
                </div>
              </div>

              {selectedProject.status === 'archived' && (
                <div className="banner" role="note">
                  ℹ️ Це legacy-архівований проєкт: доступний для перегляду, але недоступний для редагування.
                </div>
              )}

              {selectedProject.description && (
                <p className="project-detail-description">{selectedProject.description}</p>
              )}

              <div className="project-progress-summary">
                <div className="progress-summary-heading">
                  <strong>Прогрес проєкту</strong>
                  <span>{progress}%</span>
                </div>
                <ProgressBar value={progress} label="Обчислений прогрес проєкту" />
                <div className="muted progress-summary-caption">
                  {completedTaskCount} з {tasks.length} задач виконано
                  {tasksLoaded ? '' : ' · завантаження задач…'}
                </div>
              </div>

              <div className="metadata-grid">
                <div className="metadata-item">
                  <span className="muted">Відповідальний</span>
                  <strong>{selectedProject.owner || 'Не призначено'}</strong>
                </div>
                <div className="metadata-item">
                  <span className="muted">Термін виконання</span>
                  <strong>{formatDate(selectedProject.due_date)}</strong>
                </div>
                <div className="metadata-item">
                  <span className="muted">Створено</span>
                  <strong>{formatDateTime(selectedProject.created_at)}</strong>
                </div>
                <div className="metadata-item">
                  <span className="muted">Оновлено</span>
                  <strong>{formatDateTime(selectedProject.updated_at)}</strong>
                </div>
              </div>

              <div className="tasks-section">
                <div className="section-heading">
                  <div>
                    <h3>Задачі</h3>
                    <p className="muted">
                      {selectedProject.status === 'archived'
                        ? 'Legacy-архівований проєкт доступний лише для перегляду.'
                        : 'Керуйте статусом і виконавцями кожної задачі'}
                    </p>
                  </div>
                  <span className="count-badge">{tasks.length}</span>
                </div>

                {taskError && (
                  <div className="banner error" role="alert">
                    ⚠️ {taskError}
                  </div>
                )}

                {selectedProject.status !== 'archived' &&
                  (editingTaskId === null ? (
                    <TaskForm
                      form={taskForm}
                      editing={false}
                      busy={taskBusy}
                      onChange={setTaskForm}
                      onSubmit={(event) => void handleTaskSubmit(event)}
                      onCancel={cancelTaskEdit}
                    />
                  ) : (
                    <div className="inline-status task-edit-hint" role="status">
                      Задача відкрита для редагування нижче. Збережіть або скасуйте зміни.
                    </div>
                  ))}

                {tasksLoadingPlaceholder(detailLoading, tasks.length, tasksLoaded)}
                {tasks.length > 0 ? (
                  <div className="task-list">
                    {tasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        editing={editingTaskId === task.id}
                         readOnly={selectedProject.status === 'archived'}
                        draft={taskDraft}
                        busy={taskBusy && (taskActionId === null || taskActionId === task.id)}
                        onStartEdit={() => startTaskEdit(task)}
                        onDraftChange={setTaskDraft}
                        onSave={(event) => void handleTaskSubmit(event)}
                        onCancel={cancelTaskEdit}
                        onDelete={() => void handleTaskDelete(task)}
                        onStatusChange={(status) => void handleTaskStatusChange(task, status)}
                      />
                    ))}
                  </div>
                ) : tasksLoaded && !detailLoading ? (
                  <div className="empty-state task-empty-state">
                    <div className="empty-state-icon">✓</div>
                    <strong>Задач поки немає</strong>
                    <span>{selectedProject.status === 'archived'
                       ? 'У legacy-проєкті немає задач.'
                       : 'Додайте першу задачу, щоб розбити цей проєкт на кроки.'}</span>
                  </div>
                ) : null}
              </div>
            </>
          ) : detailLoading ? (
            <div className="empty-state detail-empty-state">
              <div className="empty-state-icon">⏳</div>
              <strong>Завантаження деталей…</strong>
            </div>
          ) : detailError ? (
            <div className="empty-state detail-empty-state">
              <div className="empty-state-icon">⚠️</div>
              <strong>Не вдалося завантажити проєкт</strong>
              <span>{detailError}</span>
            </div>
          ) : (
            <div className="empty-state detail-empty-state">
              <div className="empty-state-icon">👈</div>
              <strong>Оберіть проєкт</strong>
              <span>Деталі проєкту та його задачі з’являться тут.</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function tasksLoadingPlaceholder(detailLoading: boolean, taskCount: number, tasksLoaded: boolean) {
  if (detailLoading && !tasksLoaded && taskCount === 0) {
    return (
      <div className="inline-status task-loading-status" role="status">
        Завантаження задач…
      </div>
    );
  }
  return null;
}
