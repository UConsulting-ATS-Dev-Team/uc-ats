-- A member's own RSVP from the Events page, alongside Google Form and Luma rows.
-- Re-runnable: IF NOT EXISTS makes a second apply a no-op.
ALTER TYPE "EventResponseSource" ADD VALUE IF NOT EXISTS 'IN_APP';
