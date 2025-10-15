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

// Update working memory
async function updateWorkingMemory(
	pool: pg.Pool,
	schemaName: string,
	sessionsTableName: string,
	sessionId: string,
	workingMemory: string,
): Promise<void> {
	const query = `
		UPDATE ${schemaName ? `"${schemaName}".` : ''}"${sessionsTableName}"
		SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{workingMemory}', $2::jsonb, true),
			updated_at = NOW()
		WHERE id = $1
	`;

	await pool.query(query, [sessionId, JSON.stringify(workingMemory)]);
}

export class WorkingMemoryTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Working Memory',
		name: 'workingMemory',
		icon: 'file:postgresql.svg',
		group: ['transform'],
		version: 2,
		description: 'Tool for storing and updating persistent user information across conversation sessions for working memory',
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
				displayName: 'This node is designed exclusively to be used as a tool within AI agents. It utilizes advanced memory management features that is special postgres memory+ node. It does not produce direct output and is not intended for standalone use.',
				name: 'toolOnlyNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Working Memory Content',
				name: 'workingMemory',
				type: 'string',
				default: '={{ $json.workingMemory }}',
				description: 'The complete working memory content in Markdown format. This will be stored in the database. append to the template with new information.and add more information as needed.  {"workingMemory": "# User Information\n- **First Name**: John\n- **Location**: NYC\n- **Goals**: Learn Python"}. CRITICAL: Always provide COMPLETE working memory,',
				typeOptions: {
					rows: 10,
				},
				placeholder: '# User Information\n- **First Name**: \n- **Location**: \n- **Goals**: ',
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
				const schemaName = this.getNodeParameter('schemaName', i, 'public') as string;
				const sessionsTableName = this.getNodeParameter('sessionsTableName', i, 'n8n_chat_sessions') as string;
				const workingMemoryContent = this.getNodeParameter('workingMemory', i) as string;

				// Validate working memory content
				if (!workingMemoryContent) {
					throw new NodeOperationError(this.getNode(), 'Working memory content is required');
				}

				// Fire and forget - update in background
				configurePostgresPool(credentials)
					.then(async (pool) => {
						try {
							await updateWorkingMemory(pool, schemaName, sessionsTableName, sessionId, workingMemoryContent);
						} catch (error) {
							// Log error but don't throw (background operation)
							console.error('Background working memory update failed:', error);
						} finally {
							// Clean up pool
							pool.end().catch(() => {});
						}
					})
					.catch((error) => {
						console.error('Failed to configure pool for background update:', error);
					});

				// Respond immediately without waiting for DB operation
				returnData.push({
					json: {
						success: true,
						sessionId,
						result: `Working memory update queued for session: ${sessionId}`,
						storedContent: workingMemoryContent,
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