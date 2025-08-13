/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Raw } from '@vscode/prompt-tsx';
import type { CancellationToken } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IChatMLFetcher, IntentParams, Source } from '../../../platform/chat/common/chatMLFetcher';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback, OptionalChatRequestParams } from '../../../platform/networking/common/fetch';
import { IFetcherService, Response } from '../../../platform/networking/common/fetcherService';
import { IEndpointBody } from '../../../platform/networking/common/networking';
import { ITelemetryService, TelemetryProperties } from '../../../platform/telemetry/common/telemetry';
import { IThinkingDataService } from '../../../platform/thinking/node/thinkingDataService';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { OpenAIEndpoint } from './openAIEndpoint';

/**
 * Custom endpoint for Foundry Local that handles the dual delta+message streaming format.
 * Foundry Local sends both delta and message fields causing duplicate content processing.
 * This class intercepts the response to remove duplicate message fields.
 */
export class FoundryLocalEndpoint extends OpenAIEndpoint {
	constructor(
		_modelInfo: IChatModelInformation,
		_apiKey: string,
		_modelUrl: string,
		@IFetcherService fetcherService: IFetcherService,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IEnvService envService: IEnvService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThinkingDataService thinkingDataService: IThinkingDataService,
		@ILogService private _logService: ILogService
	) {
		super(
			_modelInfo,
			_apiKey,
			_modelUrl,
			fetcherService,
			domainService,
			capiClientService,
			envService,
			telemetryService,
			authService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			thinkingDataService
		);

		this._logService.info(`[FoundryLocal] Created FoundryLocalEndpoint with URL: ${_modelUrl}`);
	}

	/**
	 * Override makeChatRequest to transform Foundry Local's dual format response
	 */
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
		if (this._isFoundryLocalEndpoint()) {
			this._logService.info('[FoundryLocal] Making chat request with Foundry Local format transformation');
			
			// Wrap the original finishedCb to transform the response
			const transformedFinishedCb: FinishedCallback = async (chunk: string) => {
				let transformedChunk = chunk;
				
				try {
					// Check if this chunk contains the dual format issue
					if (chunk.includes('"delta":') && chunk.includes('"message":')) {
						this._logService.debug('[FoundryLocal] Detected dual format chunk, applying transformation');
						
						// Split by SSE data boundaries and process each event
						const lines = chunk.split('\n');
						const transformedLines: string[] = [];
						
						for (const line of lines) {
							if (line.startsWith('data: ') && line !== 'data: [DONE]') {
								try {
									const dataContent = line.substring(6); // Remove "data: " prefix
									const parsed = JSON.parse(dataContent);
									
									if (parsed.choices && Array.isArray(parsed.choices)) {
										// Remove message field from each choice to prevent duplicate processing
										parsed.choices = parsed.choices.map((choice: any) => {
											if (choice.message && choice.delta) {
												this._logService.debug('[FoundryLocal] Removing duplicate message field from choice');
												const { message, ...choiceWithoutMessage } = choice;
												return choiceWithoutMessage;
											}
											return choice;
										});
									}
									
									transformedLines.push('data: ' + JSON.stringify(parsed));
								} catch (parseError) {
									// If we can't parse, keep the original line
									this._logService.debug(`[FoundryLocal] Could not parse line, keeping original: ${parseError}`);
									transformedLines.push(line);
								}
							} else {
								// Keep non-data lines as-is (like empty lines, [DONE], etc.)
								transformedLines.push(line);
							}
						}
						
						transformedChunk = transformedLines.join('\n');
						this._logService.debug('[FoundryLocal] Applied transformation to remove duplicate message fields');
					}
				} catch (error) {
					this._logService.warn(`[FoundryLocal] Error during chunk transformation, using original: ${error}`);
					transformedChunk = chunk;
				}
				
				// Call the original finishedCb with the transformed chunk
				if (finishedCb) {
					return await finishedCb(transformedChunk);
				}
			};
			
			// Call the parent with our transformed callback
			return await super.makeChatRequest(
				debugName,
				messages,
				transformedFinishedCb,
				token,
				location,
				source,
				requestOptions,
				userInitiatedRequest,
				telemetryProperties,
				intentParams
			);
		} else {
			// For non-Foundry Local endpoints, use standard processing
			return await super.makeChatRequest(
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
		}
	}

	/**
	 * Check if this endpoint is a Foundry Local endpoint
	 */
	private _isFoundryLocalEndpoint(): boolean {
		try {
			const url = this.urlOrRequestMetadata as string;
			const isFoundryLocal = !!(url && url.includes('localhost:5273'));
			this._logService.debug(`[FoundryLocal] Checking URL: ${url}, isFoundryLocal: ${isFoundryLocal}`);
			return isFoundryLocal;
		} catch (error) {
			this._logService.warn(`[FoundryLocal] Error checking URL: ${error}`);
			return false;
		}
	}
}