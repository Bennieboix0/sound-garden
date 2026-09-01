import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './flags';
import type { Assignment, Ensemble, EnsembleMember } from '../types';
import type {
  AuthUser,
  PagePosition,
  PullResult,
  PushPayload,
  SyncTransport,
  WireScorePrefs,
  WireSetlist,
  WireStroke,
} from './transport';

/**
 * The only file in the app that knows Supabase exists.
 *
 * Everything here maps between the wire types and Postgres rows. Note what is
 * absent: there is no storage bucket, no file upload, and no code path that
 * could send PDF bytes. That is structural, not incidental.
 */

interface StrokeRow {
  id: string;
  user_id: string;
  content_hash: string;
  page_number: number;
  layer: 'personal' | 'ensemble';
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  points: number[];
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface SetlistRow {
  id: string;
  user_id: string;
  name: string;
  items: { contentHash: string; title: string }[];
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface ScorePrefsRow {
  user_id: string;
  content_hash: string;
  title: string | null;
  artist: string | null;
  crop: WireScorePrefs['crop'];
  fit_mode: 'width' | 'page' | null;
  spread: boolean | null;
  updated_at: number;
}

function strokeIn(row: StrokeRow): WireStroke {
  return {
    id: row.id,
    contentHash: row.content_hash,
    pageNumber: row.page_number,
    layer: row.layer,
    tool: row.tool,
    color: row.color,
    width: row.width,
    points: row.points ?? [],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
  };
}

function strokeOut(wire: WireStroke, userId: string): StrokeRow {
  return {
    id: wire.id,
    user_id: userId,
    content_hash: wire.contentHash,
    page_number: wire.pageNumber,
    layer: wire.layer,
    tool: wire.tool,
    color: wire.color,
    width: wire.width,
    points: wire.points,
    created_at: wire.createdAt,
    updated_at: wire.updatedAt,
    deleted_at: wire.deletedAt,
  };
}

function setlistIn(row: SetlistRow): WireSetlist {
  return {
    id: row.id,
    name: row.name,
    items: Array.isArray(row.items) ? row.items : [],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
  };
}

function prefsIn(row: ScorePrefsRow): WireScorePrefs {
  return {
    contentHash: row.content_hash,
    title: row.title,
    artist: row.artist,
    crop: row.crop,
    fitMode: row.fit_mode,
    spread: row.spread,
    updatedAt: Number(row.updated_at),
  };
}

const DISPLAY_NAME_KEY = 'display_name';

export class SupabaseTransport implements SyncTransport {
  readonly name = 'supabase';
  private client: SupabaseClient;

  constructor(url = SUPABASE_URL, anonKey = SUPABASE_ANON_KEY) {
    if (!url || !anonKey) {
      throw new Error('Supabase is not configured for this build');
    }
    this.client = createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
      // No analytics, no telemetry, no third-party SDKs — here or anywhere else
      // in this app. See the README's data minimisation section.
      global: { headers: { 'x-application-name': 'sound-garden' } },
    });
  }

  private toAuthUser(user: {
    id: string;
    email?: string | null;
    user_metadata?: Record<string, unknown>;
  }): AuthUser {
    const meta = user.user_metadata ?? {};
    const name = typeof meta[DISPLAY_NAME_KEY] === 'string' ? (meta[DISPLAY_NAME_KEY] as string) : '';
    return {
      id: user.id,
      email: user.email ?? null,
      displayName: name || 'Musician',
    };
  }

  async currentUser(): Promise<AuthUser | null> {
    const { data } = await this.client.auth.getUser();
    return data.user ? this.toAuthUser(data.user) : null;
  }

  onAuthChange(listener: (user: AuthUser | null) => void): () => void {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => {
      listener(session?.user ? this.toAuthUser(session.user) : null);
    });
    return () => data.subscription.unsubscribe();
  }

  async signUp(email: string, password: string, displayName: string): Promise<AuthUser> {
    const { data, error } = await this.client.auth.signUp({
      email,
      password,
      options: { data: { [DISPLAY_NAME_KEY]: displayName } },
    });
    if (error) throw error;
    if (!data.user) throw new Error('Check your email to confirm the account, then sign in.');
    const user = this.toAuthUser(data.user);
    await this.client
      .from('profiles')
      .upsert({ id: user.id, display_name: displayName, updated_at: new Date().toISOString() });
    return user;
  }

  async signIn(email: string, password: string): Promise<AuthUser> {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (!data.user) throw new Error('Sign-in failed');
    return this.toAuthUser(data.user);
  }

  async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut();
    if (error) throw error;
  }

  async pull(since: number): Promise<PullResult> {
    const [strokes, setlists, prefs] = await Promise.all([
      this.client.from('strokes').select('*').gte('updated_at', since),
      this.client.from('setlists').select('*').gte('updated_at', since),
      this.client.from('score_prefs').select('*').gte('updated_at', since),
    ]);
    if (strokes.error) throw strokes.error;
    if (setlists.error) throw setlists.error;
    if (prefs.error) throw prefs.error;

    const strokeRows = (strokes.data ?? []) as StrokeRow[];
    const setlistRows = (setlists.data ?? []) as SetlistRow[];
    const prefRows = (prefs.data ?? []) as ScorePrefsRow[];

    const cursor = Math.max(
      since,
      ...strokeRows.map((r) => Number(r.updated_at)),
      ...setlistRows.map((r) => Number(r.updated_at)),
      ...prefRows.map((r) => Number(r.updated_at)),
    );

    return {
      strokes: strokeRows.map(strokeIn),
      setlists: setlistRows.map(setlistIn),
      scorePrefs: prefRows.map(prefsIn),
      cursor: Number.isFinite(cursor) ? cursor : since,
    };
  }

  async push(payload: PushPayload): Promise<void> {
    const user = await this.currentUser();
    if (!user) throw new Error('Not signed in');

    if (payload.strokes.length > 0) {
      const { error } = await this.client
        .from('strokes')
        .upsert(payload.strokes.map((s) => strokeOut(s, user.id)), { onConflict: 'id' });
      if (error) throw error;
    }
    if (payload.setlists.length > 0) {
      const { error } = await this.client.from('setlists').upsert(
        payload.setlists.map((s) => ({
          id: s.id,
          user_id: user.id,
          name: s.name,
          items: s.items,
          created_at: s.createdAt,
          updated_at: s.updatedAt,
          deleted_at: s.deletedAt,
        })),
        { onConflict: 'id' },
      );
      if (error) throw error;
    }
    if (payload.scorePrefs.length > 0) {
      const { error } = await this.client.from('score_prefs').upsert(
        payload.scorePrefs.map((p) => ({
          user_id: user.id,
          content_hash: p.contentHash,
          title: p.title,
          artist: p.artist,
          crop: p.crop,
          fit_mode: p.fitMode,
          spread: p.spread,
          updated_at: p.updatedAt,
        })),
        { onConflict: 'user_id,content_hash' },
      );
      if (error) throw error;
    }
  }

  async exportMyData(): Promise<unknown> {
    const user = await this.currentUser();
    if (!user) throw new Error('Not signed in');
    const [strokes, setlists, prefs, profile] = await Promise.all([
      this.client.from('strokes').select('*'),
      this.client.from('setlists').select('*'),
      this.client.from('score_prefs').select('*'),
      this.client.from('profiles').select('*').eq('id', user.id).maybeSingle(),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      note:
        'Everything the Sound Garden server holds for this account. ' +
        'Score files are never uploaded, so none appear here — only SHA-256 hashes identifying them.',
      account: { id: user.id, email: user.email, displayName: user.displayName },
      profile: profile.data ?? null,
      strokes: strokes.data ?? [],
      setlists: setlists.data ?? [],
      scorePrefs: prefs.data ?? [],
    };
  }

  async deleteMyData(): Promise<void> {
    const { error } = await this.client.rpc('delete_my_data');
    if (error) throw error;
  }

  // --- Ensembles -----------------------------------------------------------

  async signInAnonymously(displayName: string): Promise<AuthUser> {
    // No email, no phone, no third-party identity. The refresh token on this
    // device is the whole credential, which is the point: a student needs an
    // account, not an identity.
    const { data, error } = await this.client.auth.signInAnonymously({
      options: { data: { [DISPLAY_NAME_KEY]: displayName } },
    });
    if (error) throw error;
    if (!data.user) throw new Error('Could not create an account');
    return this.toAuthUser(data.user);
  }

  async listEnsembles(): Promise<{ ensembles: Ensemble[]; members: EnsembleMember[] }> {
    const user = await this.currentUser();
    if (!user) return { ensembles: [], members: [] };

    const [groups, memberships] = await Promise.all([
      this.client.from('ensembles').select('*'),
      this.client.from('ensemble_members').select('*'),
    ]);
    if (groups.error) throw groups.error;
    if (memberships.error) throw memberships.error;

    const members: EnsembleMember[] = (memberships.data ?? []).map((row) => ({
      ensembleId: row.ensemble_id as string,
      userId: row.user_id as string,
      displayName: row.display_name as string,
      role: row.role as EnsembleMember['role'],
      joinedAt: Number(row.joined_at),
    }));
    const myRole = new Map(
      members.filter((m) => m.userId === user.id).map((m) => [m.ensembleId, m.role]),
    );

    const ensembles: Ensemble[] = (groups.data ?? []).map((row) => ({
      id: row.id as string,
      name: row.name as string,
      ownerId: row.owner_id as string,
      // Members are never shown a join code, and RLS means they cannot read one
      // for a group they do not direct anyway.
      joinCode: myRole.get(row.id as string) === 'director' ? (row.join_code as string) : undefined,
      role: myRole.get(row.id as string) ?? 'member',
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));

    return { ensembles, members };
  }

  async createEnsemble(name: string, directorName: string): Promise<Ensemble> {
    const { data, error } = await this.client.rpc('create_ensemble', {
      ensemble_name: name,
      director_name: directorName,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return {
      id: row.id,
      name: row.name,
      ownerId: row.owner_id,
      joinCode: row.join_code,
      role: 'director',
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async joinEnsemble(code: string, displayName: string): Promise<string | null> {
    const { data, error } = await this.client.rpc('join_ensemble', {
      code,
      display_name: displayName,
    });
    if (error) throw error;
    return (data as string | null) ?? null;
  }

  async rotateJoinCode(ensembleId: string): Promise<string> {
    const { data, error } = await this.client.rpc('rotate_join_code', { target: ensembleId });
    if (error) throw error;
    return data as string;
  }

  async leaveEnsemble(ensembleId: string): Promise<void> {
    const { error } = await this.client.rpc('leave_ensemble', { target: ensembleId });
    if (error) throw error;
  }

  async deleteEnsemble(ensembleId: string): Promise<void> {
    const { error } = await this.client.rpc('delete_ensemble', { target: ensembleId });
    if (error) throw error;
  }

  async publishEnsembleStrokes(ensembleId: string, strokes: WireStroke[]): Promise<void> {
    const user = await this.currentUser();
    if (!user) throw new Error('Not signed in');
    if (strokes.length === 0) return;
    const { error } = await this.client.from('strokes').upsert(
      strokes.map((s) => ({ ...strokeOut(s, user.id), layer: 'ensemble', ensemble_id: ensembleId })),
      { onConflict: 'id' },
    );
    if (error) throw error;
  }

  async pullEnsembleStrokes(ensembleId: string, since: number): Promise<WireStroke[]> {
    const { data, error } = await this.client
      .from('strokes')
      .select('*')
      .eq('ensemble_id', ensembleId)
      .gte('updated_at', since);
    if (error) throw error;
    return ((data ?? []) as StrokeRow[]).map((row) => ({
      ...strokeIn(row),
      ensembleId,
    }));
  }

  async listAssignments(): Promise<Assignment[]> {
    const { data, error } = await this.client.from('assignments').select('*');
    if (error) throw error;
    return (data ?? []).map((row) => ({
      id: row.id as string,
      ensembleId: row.ensemble_id as string,
      memberId: row.member_id as string,
      title: row.title as string,
      notes: (row.notes as string) ?? '',
      contentHash: (row.content_hash as string) ?? undefined,
      pageNumber: row.page_number === null ? undefined : Number(row.page_number),
      barReference: (row.bar_reference as string) ?? undefined,
      dueDate: row.due_date === null ? undefined : Number(row.due_date),
      completedAt: row.completed_at === null ? undefined : Number(row.completed_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  async upsertAssignment(assignment: Assignment): Promise<void> {
    const { error } = await this.client.from('assignments').upsert(
      {
        id: assignment.id,
        ensemble_id: assignment.ensembleId,
        member_id: assignment.memberId,
        title: assignment.title,
        notes: assignment.notes,
        content_hash: assignment.contentHash ?? null,
        page_number: assignment.pageNumber ?? null,
        bar_reference: assignment.barReference ?? null,
        due_date: assignment.dueDate ?? null,
        completed_at: assignment.completedAt ?? null,
        created_at: assignment.createdAt,
        updated_at: assignment.updatedAt,
      },
      { onConflict: 'id' },
    );
    if (error) throw error;
  }

  async deleteAssignment(id: string): Promise<void> {
    const { error } = await this.client.from('assignments').delete().eq('id', id);
    if (error) throw error;
  }

  async setAssignmentDone(id: string, done: boolean): Promise<void> {
    const { error } = await this.client.rpc('set_assignment_done', { target: id, done });
    if (error) throw error;
  }

  // --- Live page follow ----------------------------------------------------

  private pageChannels = new Map<string, ReturnType<SupabaseClient['channel']>>();

  private pageChannel(ensembleId: string) {
    const existing = this.pageChannels.get(ensembleId);
    if (existing) return existing;
    const channel = this.client.channel(`ensemble:${ensembleId}:page`, {
      config: { broadcast: { self: false } },
    });
    this.pageChannels.set(ensembleId, channel);
    return channel;
  }

  broadcastPage(ensembleId: string, position: PagePosition): void {
    const channel = this.pageChannel(ensembleId);
    // Deliberately not awaited. A director's page turn must never wait on a
    // socket; if the send fails, the turn has still happened locally.
    void channel.send({ type: 'broadcast', event: 'page', payload: position }).catch(() => undefined);
  }

  subscribeToPage(
    ensembleId: string,
    handler: (position: PagePosition) => void,
    onConnectionChange?: (connected: boolean) => void,
  ): () => void {
    const channel = this.pageChannel(ensembleId);
    channel.on('broadcast', { event: 'page' }, (message) => {
      const payload = message.payload as PagePosition | undefined;
      if (payload && typeof payload.pageNumber === 'number') handler(payload);
    });
    channel.subscribe((status) => {
      onConnectionChange?.(status === 'SUBSCRIBED');
    });
    return () => {
      this.pageChannels.delete(ensembleId);
      void this.client.removeChannel(channel);
    };
  }
}
