import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

const authState = vi.hoisted(() => ({ role: 'ADMIN', userId: 'admin-1' }));

const mockService = vi.hoisted(() => ({
  getCampaignTemplates: vi.fn().mockResolvedValue([]),
  createCampaignTemplate: vi.fn().mockResolvedValue({}),
  updateCampaignTemplate: vi.fn().mockResolvedValue({}),
  getCampaignTemplateById: vi.fn().mockResolvedValue({}),
  deleteCampaignTemplate: vi.fn().mockResolvedValue({}),
  getCampaignAudiences: vi.fn().mockResolvedValue([]),
  createCampaignAudience: vi.fn().mockResolvedValue({}),
  updateCampaignAudience: vi.fn().mockResolvedValue({}),
  getCampaignAudienceById: vi.fn().mockResolvedValue({}),
  deleteCampaignAudience: vi.fn().mockResolvedValue({}),
  previewAudience: vi.fn().mockResolvedValue({ count: 0 }),
  resolveAudience: vi.fn().mockResolvedValue([]),
  getCampaignSends: vi.fn().mockResolvedValue([]),
  createCampaignSend: vi.fn().mockResolvedValue({ id: 'send-1' }),
  updateCampaignSend: vi.fn().mockResolvedValue({}),
  getCampaignSendById: vi.fn().mockResolvedValue({ id: 'send-1' }),
  approveCampaignSend: vi.fn().mockResolvedValue({ id: 'send-1', status: 'APPROVED' }),
  previewCampaignSend: vi.fn().mockResolvedValue({ id: 'send-1', count: 0, renderedPreview: '<p>Preview</p>' }),
  sendCampaign: vi.fn().mockRejectedValue(new Error('Bulk campaign sends are disabled')),
  retryFailedCampaignSend: vi.fn().mockResolvedValue({ retried: 1 }),
  getSuppressedEmails: vi.fn().mockResolvedValue([]),
  addSuppressedEmail: vi.fn().mockResolvedValue({}),
  removeSuppressedEmail: vi.fn().mockResolvedValue({}),
}));

vi.mock('../services/campaigns.js', () => mockService);

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: authState.userId, role: authState.role };
    next();
  },
  requireAdmin: (req, res, next) => {
    if (req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  },
  requireAdminOrMember: (req, res, next) => {
    if (req.user?.role !== 'ADMIN' && req.user?.role !== 'MEMBER') {
      return res.status(403).json({ error: 'Admin or member access required' });
    }
    next();
  },
}));

import campaignRoutes from './campaigns.js';

describe('campaign admin routes', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/admin/campaigns', campaignRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    authState.role = 'ADMIN';
    authState.userId = 'admin-1';
  });

  async function post(path, body = {}) {
    return fetch(`http://localhost:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function get(path) {
    return fetch(`http://localhost:${port}${path}`);
  }

  it('lists templates', async () => {
    const res = await get('/api/admin/campaigns/templates');
    expect(res.status).toBe(200);
    expect(mockService.getCampaignTemplates).toHaveBeenCalled();
  });

  it('denies non-admin users', async () => {
    authState.role = 'USER';
    const res = await get('/api/admin/campaigns/templates');
    expect(res.status).toBe(403);
  });

  it('approves a send', async () => {
    const res = await post('/api/admin/campaigns/sends/send-1/approve');
    expect(res.status).toBe(200);
    expect(mockService.approveCampaignSend).toHaveBeenCalledWith({ sendId: 'send-1', actorId: 'admin-1' });
  });

  it('returns a preview for approval review', async () => {
    const res = await get('/api/admin/campaigns/sends/send-1/preview');
    expect(res.status).toBe(200);
    expect(mockService.previewCampaignSend).toHaveBeenCalledWith({ sendId: 'send-1' });
  });

  it('forwards service errors from send without exposing stack traces', async () => {
    const res = await post('/api/admin/campaigns/sends/send-1/send', {});
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Bulk campaign sends are disabled/);
  });

  it('creates a send without immediately dispatching', async () => {
    const res = await post('/api/admin/campaigns/sends', {
      name: 'Test',
      templateId: 'tmpl-1',
      audienceId: 'aud-1',
    });
    expect(res.status).toBe(200);
    expect(mockService.createCampaignSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Test', templateId: 'tmpl-1', audienceId: 'aud-1' })
    );
  });
});
