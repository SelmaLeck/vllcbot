# Vullco Twitch Bot 💙

Twitch-only, mit `!clip`, `!spotify`, eigenen Commands, Timern und Geburtstagen. Im Dashboard oben rechts kleine Twitch- und Spotify-Buttons; Footer: made by selma ♥.

## Lokal

1. `npm install` und `.env.example` nach `.env` kopieren.
2. `PANEL_PASSWORD`, `SESSION_SECRET`, `TWITCH_BOT_USERNAME`, `TWITCH_CLIENT_ID` und `TWITCH_CLIENT_SECRET` eintragen.
3. In Twitch Developer Console `http://localhost:3000/auth/twitch/callback` als Redirect eintragen.
4. Für Spotify im Spotify Developer Dashboard eine App anlegen; `SPOTIFY_CLIENT_ID` und `SPOTIFY_CLIENT_SECRET` eintragen. Als Redirect `http://127.0.0.1:3000/auth/spotify/callback` eintragen (falls die App diese Loopback-URL erlaubt). Spotify-Zugriff muss der Spotify-Account mit laufender Wiedergabe autorisieren.
5. `npm start`, dann `http://localhost:3000` öffnen, anmelden und oben rechts beide Konten verbinden. Browser-Weiterleitung nur mit **derselben** Host-Adresse nutzen, mit der du das Dashboard geöffnet hast; für Spotify daher bei Bedarf `http://127.0.0.1:3000` aufrufen.

## Railway (ohne Supabase)

1. Code in ein **privates GitHub-Repository** hochladen. **Niemals** `.env`, `data/*-auth.json` oder Session-Dateien hochladen.
2. Auf Railway ein neues Projekt aus GitHub erstellen, einen Web-Service deployen und eine öffentliche HTTPS-Domain generieren.
3. Unter **Variables** die Werte der `.env` setzen, außerdem `NODE_ENV=production`, `TRUST_PROXY=1`, `DATA_DIR=/app/data`, `TWITCH_REDIRECT_URI=https://DEINE-DOMAIN/auth/twitch/callback`, `SPOTIFY_REDIRECT_URI=https://DEINE-DOMAIN/auth/spotify/callback`. `PORT` muss nicht hart gesetzt werden.
4. **Ein Railway Volume** unter **/app/data** mounten. Dort bleiben `state.json`, OAuth-Verbindungen und Sessions beim Neustart erhalten. Ein einzelner Service mit einer Instanz; kein gemeinsamer Dateispeicher über mehrere Instanzen.
5. Die **exakten** öffentlichen HTTPS-Redirect-URLs sowohl bei Twitch als auch bei Spotify registrieren (Spotify-App-Zugang kann Entwickler-/Testmodus-Einschränkungen haben).
6. Redeploy und im Dashboard Twitch & Spotify **auf der Railway-Domain erneut verbinden**. Lokal gespeicherte Auth-Dateien werden nicht automatisch zu Railway übertragen.

**Wichtig:** Für öffentlichen Betrieb starkes Panel-Passwort und SESSION_SECRET nutzen. Die Spotify-Funktion benötigt eine aktive Wiedergabe und die passende Spotify-Account-Autorisierung. Twitch-Clips funktionieren nur bei aktiven Streams mit erlaubtem Clipping. Die Daten auf dem Volume ersetzen keine Backups; `state.json` regelmäßig sichern.
