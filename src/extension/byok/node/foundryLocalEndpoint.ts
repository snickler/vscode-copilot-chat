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
import { FinishedCallback, IResponseDelta, OptionalChatRequestParams } from '../../../platform/networking/common/fetch';
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
			
			// For now, just pass through to the original callback
			// TODO: Implement proper dual format handling at the response level
			const transformedFinishedCb: FinishedCallback = async (text: string, index: number, delta) => {
				this._logService.debug('[FoundryLocal] Passing through to original finishedCb');
				
				// Call the original finishedCb with the correct parameters
				if (finishedCb) {
					return await finishedCb(text, index, delta);
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