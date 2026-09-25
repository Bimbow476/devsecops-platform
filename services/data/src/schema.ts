import { z } from 'zod';

export const projectStatuses = [
  'planned',
  'active',
  'blocked',
  'completed',
] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

/** `archived` is retained only for records migrated from the legacy data model. */
export const persistedProjectStatuses = [
  ...projectStatuses,
  'archived',
] as const;
export type PersistedProjectStatus = (typeof persistedProjectStatuses)[number];

export const taskStatuses = ['todo', 'in_progress', 'done'] as const;
export type TaskStatus = (typeof taskStatuses)[number];

const projectStatusSchema = z.enum(projectStatuses);
const persistedProjectStatusSchema = z.enum(persistedProjectStatuses);
const taskStatusSchema = z.enum(taskStatuses);
const prioritySchema = z.number().int('priority must be an integer').min(1).max(5);

function optionalNullableText(maxLength: number, label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} cannot be empty`)
    .max(maxLength, `${label} is too long`)
    .nullable()
    .optional();
}

const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'due_date must use YYYY-MM-DD')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, 'due_date must be a valid calendar date');

export const createProjectSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'name is required')
      .max(200, 'name is too long'),
    description: optionalNullableText(5000, 'description'),
    status: projectStatusSchema.optional(),
    priority: prioritySchema.optional(),
    owner: optionalNullableText(120, 'owner'),
    due_date: dueDateSchema.nullable().optional(),
  })
  .strict();

export const updateProjectSchema = createProjectSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'no fields to update',
  });

export const createTaskSchema = z
  .object({
    project_id: z.number().int('project_id must be an integer').positive(),
    title: z
      .string()
      .trim()
      .min(1, 'title is required')
      .max(200, 'title is too long'),
    description: optionalNullableText(5000, 'description'),
    status: taskStatusSchema.optional(),
    priority: prioritySchema.optional(),
    assignee: optionalNullableText(120, 'assignee'),
    due_date: dueDateSchema.nullable().optional(),
  })
  .strict();

export const updateTaskSchema = createTaskSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'no fields to update',
  });

export const listProjectsQuerySchema = z
  .object({
    search: z.string().trim().max(200, 'search is too long').optional(),
    status: persistedProjectStatusSchema.optional(),
    limit: z.coerce
      .number()
      .int('limit must be an integer')
      .min(1)
      .max(100)
      .default(50),
    offset: z.coerce
      .number()
      .int('offset must be an integer')
      .min(0)
      .default(0),
  })
  .strict();

export const listTasksQuerySchema = z
  .object({
    search: z.string().trim().max(200, 'search is too long').optional(),
    status: taskStatusSchema.optional(),
    limit: z.coerce
      .number()
      .int('limit must be an integer')
      .min(1)
      .max(200)
      .default(50),
    offset: z.coerce
      .number()
      .int('offset must be an integer')
      .min(0)
      .default(0),
  })
  .strict();

export const idParamsSchema = z
  .object({
    id: z.coerce
      .number()
      .int('id must be an integer')
      .positive('id must be positive'),
  })
  .strict();

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type IdParams = z.infer<typeof idParamsSchema>;
