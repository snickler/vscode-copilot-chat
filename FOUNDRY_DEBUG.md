# Foundry Local Debug Information

## Current Implementation Status

### Components Created:
1. **FoundryLocalEndpoint** (`src/extension/byok/node/foundryLocalEndpoint.ts`)
   - Extends OpenAIEndpoint
   - Intercepts streaming responses from Foundry Local
   - Transforms dual delta+message format to OpenAI compatible format
   - Added comprehensive logging for debugging

2. **FoundryLocalLMProvider** (`src/extension/byok/vscode-node/foundryLocalProvider.ts`)  
   - Uses the FoundryLocalEndpoint instead of base OpenAIEndpoint
   - Integrates with foundry-local-sdk
   - Supports both thinking and non-thinking models
   - Added comprehensive logging for debugging

### Key Features:
- **Stream Format Transformation**: Removes duplicate 'message' fields while preserving 'delta' fields
- **Agent Mode Support**: Fixed priority hierarchy for prompt rendering
- **Model Detection**: Automatically detects thinking vs non-thinking models
- **Error Handling**: Comprehensive error handling with fallbacks

### Debugging Steps:
If the fix is not working, check VS Code logs for these messages:

1. **Initialization**: 
   ```
   [FoundryLocal] FoundryLocal provider initialized with service URL: http://localhost:5273
   [FoundryLocal] Foundry Local service initialized successfully
   [FoundryLocal] Found X models in Foundry Local catalog
   ```

2. **Chat Request**:
   ```
   [FoundryLocal] Starting chat response for model: <model-id>
   [FoundryLocal] Got model info for: <model-id>
   [FoundryLocal] Created custom endpoint with URL: http://localhost:5273/v1/chat/completions
   [FoundryLocal] Created FoundryLocalEndpoint with URL: http://localhost:5273/v1/chat/completions
   ```

3. **Stream Processing**:
   ```
   [FoundryLocal] Checking URL for Foundry Local: http://localhost:5273/v1/chat/completions
   [FoundryLocal] Is Foundry Local endpoint: true
   [FoundryLocal] Applying streaming format transformation
   [FoundryLocal] Starting stream transformation
   [FoundryLocal] Processing chunk X: data: {"choices":[...
   [FoundryLocal] Removed duplicate message field from choice 0
   ```

### Common Issues:
1. **URL Detection Not Working**: Check if endpoint URL detection logs show `Is Foundry Local endpoint: false`
2. **Stream Transformation Failing**: Look for error messages in stream transformation
3. **Model Loading Issues**: Check if models are loading correctly from SDK
4. **Agent Mode Issues**: Verify prompt priority hierarchy is working

### Testing Steps:
1. **Ask Mode**: Try a simple question to verify basic functionality
2. **Agent Mode**: Try using @agent with a task to verify Agent mode works
3. **Thinking Models**: Try both thinking models (phi-4-mini-reasoning) and regular models (Phi-3.5-mini-instruct)

If issues persist, enable debug logging and share the relevant log sections.