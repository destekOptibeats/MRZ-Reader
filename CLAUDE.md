# MRZ-Reader Proje Kuralları

## Otomatik Git Kuralları
Her zaman direkt main branch'ine commit ve push et, asla yeni branch oluşturma.

Her görev tamamlandıktan sonra onay beklemeden otomatik olarak:
1. git add -u
2. git commit -m "fix: [değişiklik açıklaması]"
3. git push origin main

## Çalışma Dizini Kuralı
Her zaman ~/Desktop/MRZ-Reader ana klasöründe çalış, asla worktree veya alt dizin kullanma.

## Deploy Bildirimi
Her başarılı git push işleminden sonra şu komutu çalıştır:
```
osascript -e 'display notification "Test edebilirsin! 🚀" with title "MRZ Deploy Tamamlandı" subtitle "GitHub güncellendi"'
```
