/* eslint-disable n8n-nodes-base/node-filename-against-convention */
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	INodeCredentialTestResult,
	ICredentialTestFunctions,
	ICredentialsDecrypted,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import pg from 'pg';

// Postgres credentials interface matching n8n's built-in type
interface PostgresNodeCredentials {
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	ssl?: 'disable' | 'allow' | 'require' | 'verify' | 'verify-full';
	sslCertificateAuthorityCa?: string;
	sslCertificate?: string;
	sslKey?: string;
	sslRejection?: boolean;
}

// Helper function to configure Postgres pool
async function configurePostgresPool(credentials: PostgresNodeCredentials): Promise<pg.Pool> {
	const pg = await import('pg');

	const config: pg.PoolConfig = {
		host: credentials.host,
		port: credentials.port,
		database: credentials.database,
		user: credentials.user,
		password: credentials.password,
	};

	// Handle SSL configuration
	if (credentials.ssl && credentials.ssl !== 'disable') {
		const sslConfig: any = {
			rejectUnauthorized: credentials.sslRejection !== false,
		};

		if (credentials.sslCertificateAuthorityCa) {
			sslConfig.ca = credentials.sslCertificateAuthorityCa;
		}
		if (credentials.sslCertificate) {
			sslConfig.cert = credentials.sslCertificate;
		}
		if (credentials.sslKey) {
			sslConfig.key = credentials.sslKey;
		}

		config.ssl = sslConfig;
	}

	return new pg.Pool(config);
}

// Validate working memory content (JSON only)
function validateWorkingMemory(content: any): { isValid: boolean; parsed?: any; error?: string; warning?: string } {
	try {
		let parsed;
		if (typeof content === 'string') {
			parsed = JSON.parse(content);
		} else {
			parsed = content;
		}

		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return { isValid: false, error: 'Working memory must be a valid JSON object (not array or null)' };
		}

		// Check if it looks like a minimal object (might be missing template fields)
		const fieldCount = Object.keys(parsed).length;
		let warning;
		if (fieldCount < 3) {
			warning = `Only ${fieldCount} fields provided. Remember to include ALL existing template fields + any new fields (surname, gender, etc.)`;
		}

		return { isValid: true, parsed, warning };
	} catch (error: any) {
		return { isValid: false, error: `Invalid JSON: ${error.message}` };
	}
}

// Update working memory with validation
async function updateWorkingMemory(
	pool: pg.Pool,
	schemaName: string,
	sessionsTableName: string,
	sessionId: string,
	workingMemory: any,
	scope: 'thread' | 'user' = 'thread',
	userId?: string,
): Promise<{ success: boolean; error?: string }> {
	// Validate the working memory content
	const validation = validateWorkingMemory(workingMemory);
	if (!validation.isValid) {
		return { success: false, error: validation.error };
	}

	try {
		if (scope === 'user' && userId) {
			// User-scoped: Update working memory in dedicated user memory table (SCALABLE!)
			const qualifiedUserMemoryTable = schemaName ? `"${schemaName}"."${sessionsTableName}_user_memory"` : `"${sessionsTableName}_user_memory"`;
			const query = `
				INSERT INTO ${qualifiedUserMemoryTable} (user_id, working_memory, updated_at)
				VALUES ($1, $2::jsonb, NOW())
				ON CONFLICT (user_id)
				DO UPDATE SET 
					working_memory = EXCLUDED.working_memory,
					updated_at = NOW()
			`;
			await pool.query(query, [userId, JSON.stringify(validation.parsed)]);
		} else {
			// Thread-scoped: Update working memory for specific session
			const query = `
				UPDATE ${schemaName ? `"${schemaName}".` : ''}"${sessionsTableName}"
				SET working_memory = $2::jsonb,
					updated_at = NOW()
				WHERE id = $1
			`;
			await pool.query(query, [sessionId, JSON.stringify(validation.parsed)]);
		}
		return { success: true };
	} catch (error: any) {
		return { success: false, error: `Database update failed: ${error.message}` };
	}
}

export class WorkingMemoryTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Working Memory',
		name: 'workingMemory',
		icon: 'file:postgresql.svg',
		group: ['transform'],
		version: 2,
		description: 'Update working memory with new information. Always send complete JSON object with all existing fields plus any new ones.',
		defaults: {
			name: 'Working Memory',
		},
		credentials: [
			{
				// eslint-disable-next-line n8n-nodes-base/node-class-description-credentials-name-unsuffixed
				name: 'postgres',
				required: true,
				testedBy: 'postgresConnectionTest',
			},
		],
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Tools', 'Memory'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://github.com/rufaromugabe/n8n-nodes-postgres-memory-advanced',
					},
				],
			},
		},

		inputs: [],

		outputs: [],
		usableAsTool: true,
		properties: [
			{
				displayName: 'Note',
				name: 'notice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: {
						'@version': [1],
					},
				},
			},
			{
				displayName: 'AI Agent Tool: Updates persistent user working memory.',
				name: 'toolOnlyNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Working Memory Content',
				name: 'workingMemory',
				type: 'json',
				default: '={{ $json.workingMemory }}',
				description: 'Complete working memory as JSON object. Base template provides structure, but you can add new fields (surname, gender, age, phone, etc.). Always include ALL current fields plus new ones.',
				typeOptions: {
					rows: 10,
				},
				placeholder: '{\n  "name": "John",\n  "location": "",\n  "occupation": "",\n  "interests": [],\n  "goals": [],\n  "preferences": {},\n  "surname": "Smith",\n  "gender": "male"\n}',
				required: true,
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '={{ $json.sessionId }}',
				description: 'The session ID to store working memory for. Should match the Postgres Memory+ node session ID.',
				required: true,
			},
			{
				displayName: 'User Options',
				name: 'userOptions',
				type: 'collection',
				placeholder: 'Add User Option',
				default: {},
				options: [
					{
						displayName: 'User ID',
						name: 'userId',
						type: 'string',
						default: '={{ $json.userId }}',
						description: 'Optional user identifier for user-scoped working memory. Leave empty for thread-scoped memory.',
					},
					{
						displayName: 'Working Memory Scope',
						name: 'workingMemoryScope',
						type: 'options',
						options: [
							{
								name: 'Thread-Scoped',
								value: 'thread',
								description: 'Working memory is isolated per conversation thread',
							},
							{
								name: 'User-Scoped',
								value: 'user',
								description: 'Working memory persists across all threads for the same user (requires User ID)',
							},
						],
						default: 'thread',
						description: 'Choose how working memory is scoped - per thread or per user. Must match Postgres Memory+ node setting.',
					},
				],
			},
			{
				displayName: 'Schema Name',
				name: 'schemaName',
				type: 'string',
				default: 'public',
				description: 'The schema where the sessions table is located',
			},
			{
				displayName: 'Sessions Table Name',
				name: 'sessionsTableName',
				type: 'string',
				default: 'n8n_chat_sessions',
				description: 'Name of the sessions table (must match the Postgres Memory+ node configuration)',
			},
		],
	};

	methods = {
		credentialTest: {
			async postgresConnectionTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const credentials = credential.data as unknown as PostgresNodeCredentials;

				try {
					const pool = await configurePostgresPool(credentials);
					const client = await pool.connect();
					await client.query('SELECT 1');
					client.release();
					await pool.end();

					return {
						status: 'OK',
						message: 'Connection successful',
					};
				} catch (error) {
					return {
						status: 'Error',
						message: error.message,
					};
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		// Process all items - respond immediately and update in background
		for (let i = 0; i < items.length; i++) {
			try {
				const credentials = await this.getCredentials<PostgresNodeCredentials>('postgres');
				const sessionId = this.getNodeParameter('sessionId', i) as string;

				// Get user options
				const userOptions = this.getNodeParameter('userOptions', i, {}) as {
					userId?: string;
					workingMemoryScope?: 'thread' | 'user';
				};
				const userId = userOptions.userId || '';
				const workingMemoryScope = userOptions.workingMemoryScope || 'thread';

				const schemaName = this.getNodeParameter('schemaName', i, 'public') as string;
				const sessionsTableName = this.getNodeParameter('sessionsTableName', i, 'n8n_chat_sessions') as string;
				const workingMemoryContent = this.getNodeParameter('workingMemory', i);

				// Validate working memory content
				if (!workingMemoryContent) {
					throw new NodeOperationError(this.getNode(), 'Working memory content is required');
				}

				// Validate user-scoped memory requirements
				if (workingMemoryScope === 'user' && !userId) {
					throw new NodeOperationError(this.getNode(), 'User ID is required for user-scoped working memory');
				}

				// Validate JSON content
				const validation = validateWorkingMemory(workingMemoryContent);
				if (!validation.isValid) {
					throw new NodeOperationError(this.getNode(), `Invalid JSON format: ${validation.error}`);
				}

				// Log warning if object seems incomplete
				if (validation.warning) {
					console.warn(`Working Memory Warning: ${validation.warning}`);
				}

				// Update working memory in background
				configurePostgresPool(credentials)
					.then(async (pool) => {
						try {
							const result = await updateWorkingMemory(pool, schemaName, sessionsTableName, sessionId, validation.parsed, workingMemoryScope, userId || undefined);
							if (!result.success) {
								console.error('Working memory update failed:', result.error);
							}
						} catch (error) {
							console.error('Working memory update failed:', error);
						} finally {
							pool.end().catch(() => { });
						}
					})
					.catch((error) => {
						console.error('Failed to configure database pool:', error);
					});

				// Respond immediately
				returnData.push({
					json: {
						success: true,
						sessionId,
						userId: userId || null,
						scope: workingMemoryScope,
						format: 'json',
						result: `Working memory (${workingMemoryScope}-scoped) update queued for ${workingMemoryScope === 'user' ? `user: ${userId}` : `session: ${sessionId}`}`,
						storedContent: validation.parsed,
						async: true,
					},
					pairedItem: { item: i },
				});

			} catch (error: any) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							success: false,
							error: error.message,
							sessionId: items[i].json.sessionId || 'unknown',
						},
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}