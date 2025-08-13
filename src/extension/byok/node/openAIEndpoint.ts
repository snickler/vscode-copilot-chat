/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { OpenAI, Raw } from '@vscode/prompt-tsx';
import type { CancellationToken } from 'vscode';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IChatMLFetcher, IntentParams, Source } from '../../../platform/chat/common/chatMLFetcher';
import { ChatFetchResponseType, ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ChatEndpoint } from '../../../platform/endpoint/node/chatEndpoint';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback, OptionalChatRequestParams } from '../../../platform/networking/common/fetch';
import { IFetcherService, Response } from '../../../platform/networking/common/fetcherService';
import { IChatEndpoint, IEndpointBody } from '../../../platform/networking/common/networking';
import { ChatCompletion } from '../../../platform/networking/common/openai';
import { ITelemetryService, TelemetryProperties } from '../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../platform/telemetry/common/telemetryData';
import { IThinkingDataService } from '../../../platform/thinking/node/thinkingDataService';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';

function hydrateBYOKErrorMessages(response: ChatResponse): ChatResponse {
	if (response.type === ChatFetchResponseType.Failed && response.streamError) {
		return {
			type: response.type,
			requestId: response.requestId,
			serverRequestId: response.serverRequestId,
			reason: JSON.stringify(response.streamError),
		};
	} else if (response.type === ChatFetchResponseType.RateLimited) {
		return {
			type: response.type,
			requestId: response.requestId,
			serverRequestId: response.serverRequestId,
			reason: response.capiError ? 'Rate limit exceeded\n\n' + JSON.stringify(response.capiError) : 'Rate limit exceeded',
			rateLimitKey: '',
			retryAfter: undefined,
			capiError: response.capiError
		};
	}
	return response;
}

export class OpenAIEndpoint extends ChatEndpoint {
	constructor(
		private readonly _modelInfo: IChatModelInformation,
		private readonly _apiKey: string,
		private readonly _modelUrl: string,
		@IFetcherService fetcherService: IFetcherService,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IEnvService envService: IEnvService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IThinkingDataService private thinkingDataService: IThinkingDataService,
		@ILogService private logService: ILogService
	) {
		super(
			_modelInfo,
			domainService,
			capiClientService,
			fetcherService,
			envService,
			telemetryService,
			authService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService
		);
	}

	/**
	 * Transforms Foundry Local's dual delta+message format to standard OpenAI streaming format.
	 * Foundry Local sends both 'delta' and 'message' in each chunk, causing VS Code's parser
	 * to process the same content twice. This method removes the 'message' field while keeping 'delta'.
	 */
	private async transformFoundryLocalStream(response: Response, logService: ILogService): Promise<Response> {
		// Only apply transformation for Foundry Local endpoints
		if (!this._modelUrl.includes('localhost:5273') && !this._modelUrl.includes('foundry')) {
			return response;
		}

		logService.info('[FoundryLocal] Applying stream format transformation');

		const originalBody = await response.body() as NodeJS.ReadableStream;
		const { Readable } = await import('stream');
		
		// Create a transform stream to fix the format
		const transformedStream = new Readable({
			read() {
				// No-op, we'll push data as it comes
			}
		});

		let buffer = '';
		originalBody.setEncoding('utf8');
		
		originalBody.on('data', (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split('\n');
			
			// Keep the last incomplete line in buffer
			buffer = lines.pop() || '';
			
			for (const line of lines) {
				if (!line.startsWith('data: ')) {
					transformedStream.push(line + '\n');
					continue;
				}
				
				const data = line.substring(6).trim();
				if (data === '[DONE]') {
					transformedStream.push(line + '\n');
					continue;
				}
				
				try {
					const json = JSON.parse(data);
					
					// Transform each choice to remove the 'message' field
					if (json.choices && Array.isArray(json.choices)) {
						json.choices = json.choices.map((choice: any) => {
							// Remove the 'message' field to avoid duplicate processing
							const { message, ...cleanChoice } = choice;
							return cleanChoice;
						});
					}
					
					// Send the cleaned JSON
					transformedStream.push(`data: ${JSON.stringify(json)}\n`);
				} catch (e) {
					// If parsing fails, pass through as-is
					logService.warn(`[FoundryLocal] Failed to parse SSE line, passing through: ${e}`);
					transformedStream.push(line + '\n');
				}
			}
		});

		originalBody.on('end', () => {
			// Process any remaining buffer
			if (buffer.trim()) {
				transformedStream.push(buffer + '\n');
			}
			transformedStream.push(null); // End the stream
		});

		originalBody.on('error', (err) => {
			transformedStream.destroy(err);
		});

		// Create a new response with the transformed stream
		return {
			...response,
			body: () => Promise.resolve(transformedStream)
		};
	}

	override async processResponseFromChatEndpoint(
		telemetryService: ITelemetryService,
		logService: ILogService,
		response: Response,
		expectedNumChoices: number,
		finishCallback: FinishedCallback,
		telemetryData: TelemetryData,
		cancellationToken?: CancellationToken
	): Promise<AsyncIterableObject<ChatCompletion>> {
		// Transform the response if it's from Foundry Local
		const transformedResponse = await this.transformFoundryLocalStream(response, logService);
		
		// Use the standard processing with the transformed response
		return super.processResponseFromChatEndpoint(
			telemetryService,
			logService,
			transformedResponse,
			expectedNumChoices,
			finishCallback,
			telemetryData,
			cancellationToken
		);
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		super.interceptBody(body);
		// TODO @lramos15 - We should do this for all models and not just here
		if (body?.tools?.length === 0) {
			delete body.tools;
		}

		if (body?.messages) {
			const newMessages = body.messages.map((message: OpenAI.ChatMessage) => {
				if (message.role === OpenAI.ChatRole.Assistant && message.tool_calls && message.tool_calls.length > 0) {
					const id = message.tool_calls[0].id;
					const thinking = this.thinkingDataService.get(id);
					if (thinking?.id) {
						return {
							...message,
							cot_id: thinking.id,
							cot_summary: thinking.text,
						};
					}
				}
				return message;
			});
			body.messages = newMessages;
		}

		if (body) {
			if (this._modelInfo.capabilities.supports.thinking) {
				delete body.temperature;
				body['max_completion_tokens'] = body.max_tokens;
				delete body.max_tokens;
			}
			// Removing max tokens defaults to the maximum which is what we want for BYOK
			delete body.max_tokens;
			body['stream_options'] = { 'include_usage': true };
		}
	}

	override get urlOrRequestMetadata(): string {
		return this._modelUrl;
	}

	public getExtraHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json"
		};
		if (this._modelUrl.includes('openai.azure')) {
			headers['api-key'] = this._apiKey;
		} else {
			headers['Authorization'] = `Bearer ${this._apiKey}`;
		}
		return headers;
	}

	override async acceptChatPolicy(): Promise<boolean> {
		return true;
	}

	override cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		const newModelInfo = { ...this._modelInfo, maxInputTokens: modelMaxPromptTokens };
		return this.instantiationService.createInstance(OpenAIEndpoint, newModelInfo, this._apiKey, this._modelUrl);
	}

	override async makeChatRequest(
		debugName: string,
		messages: Raw.ChatMessage[],
		finishedCb: FinishedCallback | undefined,
		token: CancellationToken,
		location: ChatLocation,
		source?: Source,
		requestOptions?: Omit<OptionalChatRequestParams, 'n'>,
		userInitiatedRequest?: boolean,
		telemetryProperties?: TelemetryProperties,
		intentParams?: IntentParams
	): Promise<ChatResponse> {
		const response = await super.makeChatRequest(
			debugName,
			messages,
			finishedCb,
			token,
			location,
			source,
			requestOptions,
			userInitiatedRequest,
			telemetryProperties,
			intentParams
		);
		return hydrateBYOKErrorMessages(response);
	}
}
