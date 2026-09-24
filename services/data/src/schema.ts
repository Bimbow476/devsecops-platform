import { z } from 'zod';

export const recordStatuses = ['new', 'in_progress', 'done', 'archived'] as const;
export type RecordStatus = (typeof recordStatuses)[number];

export const createRecordSchema = z.object({
  title: z.string().min(1, 'title is required').max(120, 'title is too long'),
  description: z.string().max(2000, 'description is too long').nullable().optional(),
  status: z.enum(recordStatuses).optional(),
  priority: z.number().int('priority must be an integer').min(1).max(5).optional(),
});

export const updateRecordSchema = createRecordSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'no fields to update',
  });

export type CreateRecordInput = z.infer<typeof createRecordSchema>;
export type UpdateRecordInput = z.infer<typeof updateRecordSchema>;