#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Aurelia Method — One-Command Render Deployment Script
# Usage: bash deploy.sh <your-github-repo-url>
# Example: bash deploy.sh https://github.com/yourname/aurelia-voice-agent
# ─────────────────────────────────────────────────────────────────────────────

set -e

GITHUB_REPO_URL=$1
RENDER_API_KEY="rnd_Ute9mnS2D0xjJZjHoPzQ5HcTqVb7"
RENDER_OWNER_ID="tea-d7ogjm9o3t8c73e4his0"

if [ -z "$GITHUB_REPO_URL" ]; then
  echo "❌ Usage: bash deploy.sh <your-github-repo-url>"
  echo "   Example: bash deploy.sh https://github.com/yourname/aurelia-voice-agent"
  exit 1
fi

echo "🚀 Step 1: Pushing code to GitHub..."
git remote remove origin 2>/dev/null || true
git remote add origin "$GITHUB_REPO_URL"
git branch -M main
git push -u origin main
echo "✅ Code pushed to GitHub"

echo ""
echo "🔧 Step 2: Creating Render web service..."
SERVICE_RESPONSE=$(curl -s -X POST "https://api.render.com/v1/services" \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"web_service\",
    \"name\": \"aurelia-voice-agent\",
    \"ownerId\": \"$RENDER_OWNER_ID\",
    \"repo\": \"$GITHUB_REPO_URL\",
    \"branch\": \"main\",
    \"autoDeploy\": \"yes\",
    \"serviceDetails\": {
      \"env\": \"node\",
      \"buildCommand\": \"npm install\",
      \"startCommand\": \"node server.js\",
      \"plan\": \"free\",
      \"region\": \"oregon\",
      \"numInstances\": 1,
      \"healthCheckPath\": \"/\"
    },
    \"envVars\": [
      {\"key\": \"XAI_API_KEY\",                 \"value\": \"xai-iuH7ar2gjs2OPeG9Fpm5qGmeYDWH4AbZ0Yl1tsmNMJ7kDZXqqkQkd5Z6Vai5xhmV2fBFMVOixNjLppf4\"},
      {\"key\": \"TWILIO_ACCOUNT_SID\",          \"value\": \"ACe1fdad2f45b5dcd969aa76a91c3c30a6\"},
      {\"key\": \"TWILIO_AUTH_TOKEN\",           \"value\": \"660cd1a1e985984d5310b65c790ccf56\"},
      {\"key\": \"TWILIO_PHONE_NUMBER\",         \"value\": \"+19342470094\"},
      {\"key\": \"SUPABASE_URL\",               \"value\": \"https://hjtkfolkmkhqfdvmdmhw.supabase.co\"},
      {\"key\": \"SUPABASE_SERVICE_ROLE_KEY\",   \"value\": \"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhqdGtmb2xrbWtocWZkdm1kbWh3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NjU2MzQ4OCwiZXhwIjoyMDkyMTM5NDg4fQ.SZh49Sb6930LulBGc1JYsGE0mEpT9sPEbFGKRfWSN7E\"},
      {\"key\": \"SENDGRID_API_KEY\",            \"value\": \"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\"},
      {\"key\": \"SENDGRID_FROM_EMAIL\",         \"value\": \"support@aureliamethod.com\"},
      {\"key\": \"STRIPE_LINK_30DAY\",          \"value\": \"REPLACE_AFTER_CREATING_STRIPE_LINK\"},
      {\"key\": \"STRIPE_LINK_60DAY\",          \"value\": \"REPLACE_AFTER_CREATING_STRIPE_LINK\"},
      {\"key\": \"STRIPE_LINK_90DAY\",          \"value\": \"https://aureliamethod.com/#contact\"},
      {\"key\": \"NODE_ENV\",                   \"value\": \"production\"}
    ]
  }")

SERVICE_ID=$(echo "$SERVICE_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('service',{}).get('id','ERROR'))" 2>/dev/null)
SERVICE_URL=$(echo "$SERVICE_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('service',{}).get('serviceDetails',{}).get('url','pending'))" 2>/dev/null)

if [ "$SERVICE_ID" = "ERROR" ] || [ -z "$SERVICE_ID" ]; then
  echo "⚠️  Render response:"
  echo "$SERVICE_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$SERVICE_RESPONSE"
  exit 1
fi

echo "✅ Render service created: $SERVICE_ID"
echo "   URL will be: https://aurelia-voice-agent.onrender.com"

echo ""
echo "📞 Step 3: Updating Twilio voice webhook..."
RENDER_URL="https://aurelia-voice-agent.onrender.com"

# Get phone number SID
PHONE_SID=$(curl -s "https://api.twilio.com/2010-04-01/Accounts/ACe1fdad2f45b5dcd969aa76a91c3c30a6/IncomingPhoneNumbers.json" \
  -u "ACe1fdad2f45b5dcd969aa76a91c3c30a6:660cd1a1e985984d5310b65c790ccf56" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d['incoming_phone_numbers'][0]['sid'])")

curl -s -X POST "https://api.twilio.com/2010-04-01/Accounts/ACe1fdad2f45b5dcd969aa76a91c3c30a6/IncomingPhoneNumbers/${PHONE_SID}.json" \
  -u "ACe1fdad2f45b5dcd969aa76a91c3c30a6:660cd1a1e985984d5310b65c790ccf56" \
  --data-urlencode "VoiceUrl=${RENDER_URL}/incoming" \
  --data-urlencode "VoiceMethod=POST" > /dev/null

echo "✅ Twilio webhook updated → ${RENDER_URL}/incoming"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "✅ DEPLOYMENT COMPLETE"
echo "═══════════════════════════════════════════════════════════"
echo "Voice Agent URL: ${RENDER_URL}"
echo "Health check:    ${RENDER_URL}/"
echo "Inbound calls:   ${RENDER_URL}/incoming"
echo ""
echo "⚡ NEXT STEPS:"
echo "  1. Wait ~2 min for Render to build and start"
echo "  2. Open ${RENDER_URL} in your browser — should show {status: ok}"
echo "  3. In Stripe → Payment Links → create 30-Day (\$548) + 60-Day (\$897) links"
echo "     Then update STRIPE_LINK_30DAY + STRIPE_LINK_60DAY in Render dashboard env vars"
echo "  4. Call +1 934 247 0094 to test — Morgan should answer!"
echo "═══════════════════════════════════════════════════════════"
