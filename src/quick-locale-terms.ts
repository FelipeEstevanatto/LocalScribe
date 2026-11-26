/**
 * Quick tools copy in every UI language: English | pt | es | fr | de | zh | ja
 * | ko | ru per line, in QUICK_LANGUAGES order. Loaded on demand (about 27 KB
 * gzip) with a non-English UI; English needs no table.
 */
const terms = `
Quick tools|Ferramentas rápidas|Herramientas rápidas|Outils rapides|Schnellwerkzeuge|快捷工具|クイックツール|빠른 도구|Быстрые инструменты
Open tool|Abrir ferramenta|Abrir herramienta|Ouvrir l’outil|Werkzeug öffnen|打开工具|ツールを開く|도구 열기|Открыть инструмент
Estimated size|Tamanho estimado|Tamaño estimado|Taille estimée|Geschätzte Größe|估计大小|推定サイズ|예상 크기|Расчётный размер
Video tools|Ferramentas de vídeo|Herramientas de vídeo|Outils vidéo|Videowerkzeuge|视频工具|動画ツール|동영상 도구|Видеоинструменты
Image tools|Ferramentas de imagem|Herramientas de imagen|Outils image|Bildwerkzeuge|图像工具|画像ツール|이미지 도구|Инструменты для изображений
Center layer|Centralizar camada|Centrar capa|Centrer le calque|Ebene zentrieren|图层居中|レイヤーを中央に配置|레이어를 가운데로|Центрировать слой
Extract audio instead|Extrair áudio do vídeo|Extraer el audio del vídeo|Extraire plutôt l’audio|Stattdessen Audio extrahieren|改为提取音频|音声の抽出に切り替える|오디오 추출로 전환|Извлечь звук из видео
Quality preset|Qualidade predefinida|Ajuste de calidad|Qualité prédéfinie|Qualitätsvorgabe|画质预设|画質プリセット|품질 사전 설정|Предустановка качества
High|Alta|Alta|Élevée|Hoch|高|高|높음|Высокое
Medium|Média|Media|Moyenne|Mittel|中|中|보통|Среднее
Low|Baixa|Baja|Basse|Niedrig|低|低|낮음|Низкое
Tool|Ferramenta|Herramienta|Outil|Werkzeug|工具|ツール|도구|Инструмент
Language|Idioma|Idioma|Langue|Sprache|语言|言語|언어|Язык
Change language|Alterar idioma|Cambiar idioma|Changer de langue|Sprache ändern|切换语言|言語を変更|언어 변경|Изменить язык
Source|Origem|Original|Source|Quelle|原文件|元ファイル|원본|Источник
Result|Resultado|Resultado|Résultat|Ergebnis|结果|結果|결과|Результат
Settings|Configurações|Ajustes|Réglages|Einstellungen|设置|設定|설정|Настройки
Open in studio|Abrir no estúdio|Abrir en el editor|Ouvrir dans le studio|Im Studio öffnen|在工作室中打开|スタジオで開く|스튜디오에서 열기|Открыть в студии
Video converter|Conversor de vídeo|Conversor de vídeo|Convertisseur vidéo|Videokonverter|视频转换|動画変換|동영상 변환|Конвертер видео
Video compressor|Compressor de vídeo|Compresor de vídeo|Compression vidéo|Videokompressor|视频压缩|動画圧縮|동영상 압축|Сжатие видео
Video trimmer|Cortar vídeo|Recortar vídeo|Découper une vidéo|Video zuschneiden|视频裁剪|動画のトリミング|동영상 자르기|Обрезка видео
Extract audio|Extrair áudio|Extraer audio|Extraire l’audio|Audio extrahieren|提取音频|音声を抽出|오디오 추출|Извлечь аудио
Rotate and flip|Girar e espelhar|Girar y reflejar|Pivoter et retourner|Drehen und spiegeln|旋转和翻转|回転と反転|회전 및 뒤집기|Поворот и отражение
Change video speed|Alterar velocidade|Cambiar velocidad|Modifier la vitesse|Wiedergabetempo ändern|调整视频速度|動画速度の変更|재생 속도 변경|Скорость видео
Reverse video|Inverter vídeo|Invertir vídeo|Inverser la vidéo|Video rückwärts|视频倒放|逆再生動画|동영상 역재생|Видео задом наперёд
Extract frames|Extrair quadros|Extraer fotogramas|Extraire des images|Einzelbilder extrahieren|提取帧|フレーム抽出|프레임 추출|Извлечение кадров
Video to GIF|Vídeo para GIF|Vídeo a GIF|Vidéo en GIF|Video zu GIF|视频转 GIF|動画から GIF|동영상을 GIF로|Видео в GIF
Video watermark|Marca d’água em vídeo|Marca de agua en vídeo|Filigrane vidéo|Video-Wasserzeichen|视频水印|動画の透かし|동영상 워터마크|Водяной знак на видео
Video collage|Colagem de vídeo|Collage de vídeo|Collage vidéo|Videocollage|视频拼贴|動画コラージュ|동영상 콜라주|Видеоколлаж
Image converter|Conversor de imagem|Conversor de imágenes|Convertisseur d’images|Bildkonverter|图片转换|画像変換|이미지 변환|Конвертер изображений
Image watermark|Marca d’água em imagem|Marca de agua en imagen|Filigrane d’image|Bild-Wasserzeichen|图片水印|画像の透かし|이미지 워터마크|Водяной знак на изображении
Drawing grid|Grade de desenho|Cuadrícula de dibujo|Grille de dessin|Zeichenraster|绘画网格|描画グリッド|그리기 격자|Сетка для рисования
Refine background|Refinar fundo|Ajustar fondo|Retoucher le fond|Hintergrund korrigieren|优化抠图|背景の調整|배경 다듬기|Уточнение фона
Image collage|Colagem de imagens|Collage de imágenes|Collage d’images|Bildcollage|图片拼贴|画像コラージュ|이미지 콜라주|Коллаж изображений
Drop a file or browse|Solte um arquivo ou selecione|Suelta o selecciona un archivo|Déposer ou choisir un fichier|Datei ablegen oder auswählen|拖放或选择文件|ファイルをドロップまたは選択|파일을 놓거나 선택|Перетащите или выберите файл
Drop or add files|Solte ou adicione arquivos|Suelta o añade archivos|Déposer ou ajouter des fichiers|Dateien ablegen oder hinzufügen|拖放或添加文件|ファイルをドロップまたは追加|파일을 놓거나 추가|Перетащите или добавьте файлы
Replace image or video|Substituir imagem ou vídeo|Reemplazar imagen o vídeo|Remplacer le média|Medium ersetzen|替换图片或视频|画像・動画を置き換える|이미지 또는 영상 교체|Заменить фото или видео
Export|Exportar|Exportar|Exporter|Exportieren|导出|書き出し|내보내기|Экспорт
Download|Baixar|Descargar|Télécharger|Herunterladen|下载|ダウンロード|다운로드|Скачать
Download ZIP|Baixar ZIP|Descargar ZIP|Télécharger le ZIP|ZIP herunterladen|下载 ZIP|ZIP をダウンロード|ZIP 다운로드|Скачать ZIP
Cancel|Cancelar|Cancelar|Annuler|Abbrechen|取消|キャンセル|취소|Отменить
Preview|Prévia|Vista previa|Aperçu|Vorschau|预览|プレビュー|미리보기|Предпросмотр
Progress|Progresso|Progreso|Progression|Fortschritt|进度|進捗|진행률|Прогресс
Audio exported.|Áudio exportado.|Audio exportado.|Audio exporté.|Audio exportiert.|音频已导出。|音声を書き出しました。|오디오를 내보냈습니다.|Звук экспортирован.
AAC copied from source.|AAC copiado da origem.|AAC copiado del original.|AAC copié depuis la source.|AAC aus der Quelle kopiert.|已复制原始 AAC。|元の AAC をコピーしました。|원본 AAC를 복사했습니다.|AAC скопирован из источника.
Re-encoded for the selected settings.|Recodificado com as opções selecionadas.|Recodificado con los ajustes seleccionados.|Réencodé selon les réglages choisis.|Mit den gewählten Einstellungen neu kodiert.|已按所选设置重新编码。|選択した設定で再エンコードしました。|선택한 설정으로 다시 인코딩했습니다.|Перекодировано с выбранными настройками.
Rotation metadata updated.|Metadados de rotação atualizados.|Metadatos de rotación actualizados.|Métadonnées de rotation mises à jour.|Drehmetadaten aktualisiert.|已更新旋转元数据。|回転メタデータを更新しました。|회전 메타데이터를 업데이트했습니다.|Метаданные поворота обновлены.
Source already fits the size target. No re-encoding needed.|O arquivo original já atende ao tamanho desejado. Recodificação dispensada.|El original ya cumple el tamaño deseado. Se guardó sin recodificar.|La source respecte déjà la taille cible. Elle a été conservée telle quelle.|Die Quelldatei erfüllt bereits die Zielgröße. Sie wurde unverändert übernommen.|源文件已满足目标大小，可直接保存。|元ファイルは目標サイズ内のため、そのまま保存できます。|원본이 이미 목표 크기 이내이므로 그대로 저장할 수 있습니다.|Исходный файл уже соответствует целевому размеру. Перекодирование не требуется.
JPEG replaces transparency with the selected background.|O JPEG substitui a transparência pelo fundo selecionado.|JPEG cambia la transparencia por el fondo elegido.|JPEG remplace la transparence par le fond sélectionné.|JPEG ersetzt Transparenz durch den gewählten Hintergrund.|JPEG 用所选背景替换透明区域。|JPEG では透明部分に選択した背景を使用します。|JPEG는 투명 영역을 선택한 배경으로 채웁니다.|JPEG заменяет прозрачность выбранным фоном.
Image conversion exports a still GIF with a limited palette.|A conversão de imagem exporta um GIF estático com paleta limitada.|La conversión genera un GIF estático con una paleta limitada.|La conversion génère un GIF fixe à palette limitée.|Die Bildkonvertierung erzeugt ein Standbild-GIF mit begrenzter Palette.|图像转换会导出有限色彩的静态 GIF。|画像変換では色数が限られた静止 GIF を書き出します。|이미지 변환은 제한된 팔레트의 정지 GIF를 내보냅니다.|При преобразовании изображения создаётся статический GIF с ограниченной палитрой.
Ready.|Pronto.|Listo.|Prêt.|Bereit.|就绪。|準備完了。|준비되었습니다.|Готово.
Cancelled.|Cancelado.|Cancelado.|Annulé.|Abgebrochen.|已取消。|キャンセルしました。|취소되었습니다.|Отменено.
Export ready.|Exportação pronta.|Exportación lista.|Export prêt.|Export fertig.|导出完成。|書き出し完了。|내보내기가 완료되었습니다.|Экспорт готов.
Opening media…|Abrindo mídia…|Abriendo archivo…|Ouverture…|Datei wird geöffnet…|正在打开媒体…|ファイルを開いています…|미디어를 여는 중…|Открытие файла…
Processing on this device…|Processando neste dispositivo…|Procesando en este dispositivo…|Traitement sur cet appareil…|Lokale Verarbeitung…|正在本机处理…|この端末で処理中…|이 기기에서 처리 중…|Обработка на устройстве…
Format|Formato|Formato|Format|Format|格式|形式|형식|Формат
Resolution|Resolução|Resolución|Résolution|Auflösung|分辨率|解像度|해상도|Разрешение
Quality (%)|Qualidade (%)|Calidad (%)|Qualité (%)|Qualität (%)|画质 (%)|画質 (%)|품질 (%)|Качество (%)
Target|Meta|Objetivo|Cible|Ziel|目标|目標|목표|Цель
Start time|Início|Inicio|Début|Beginn|开始时间|開始時間|시작 시간|Начало
End time|Fim|Fin|Fin|Ende|结束时间|終了時間|종료 시간|Конец
Audio|Áudio|Audio|Audio|Audio|音频|音声|오디오|Аудио
Audio track|Faixa de áudio|Pista de audio|Piste audio|Audiospur|音轨|音声トラック|오디오 트랙|Аудиодорожка
Audio format|Formato de áudio|Formato de audio|Format audio|Audioformat|音频格式|音声形式|오디오 형식|Формат аудио
Audio bitrate|Taxa de bits de áudio|Tasa de bits de audio|Débit audio|Audio-Bitrate|音频码率|音声ビットレート|오디오 비트레이트|Битрейт аудио
Mute|Sem áudio|Silenciar|Muet|Stumm|静音|ミュート|음소거|Без звука
Keep audio|Manter áudio|Conservar audio|Garder l’audio|Audio behalten|保留音频|音声を保持|오디오 유지|Сохранить звук
Reverse audio|Inverter áudio|Invertir audio|Inverser l’audio|Audio umkehren|音频倒放|音声を逆再生|오디오 역재생|Обратить звук
Rotation|Rotação|Rotación|Rotation|Drehung|旋转|回転|회전|Поворот
Mirror horizontally|Espelhar na horizontal|Reflejar horizontalmente|Retourner horizontalement|Horizontal spiegeln|水平翻转|左右反転|좌우 뒤집기|Отразить по горизонтали
Mirror vertically|Espelhar na vertical|Reflejar verticalmente|Retourner verticalement|Vertikal spiegeln|垂直翻转|上下反転|상하 뒤집기|Отразить по вертикали
Speed (×)|Velocidade (×)|Velocidad (×)|Vitesse (×)|Tempo (×)|速度 (×)|速度 (×)|속도 (×)|Скорость (×)
Frame rate|Taxa de quadros|Fotogramas por segundo|Cadence|Bildrate|帧率|フレームレート|프레임 속도|Частота кадров
Loop|Loop|Bucle|Boucle|Schleife|循环|ループ|반복|Повтор
Frame format|Formato dos quadros|Formato de fotograma|Format des images|Bildformat|帧格式|フレーム形式|프레임 형식|Формат кадров
Interval (s)|Intervalo (s)|Intervalo (s)|Intervalle (s)|Intervall (s)|间隔（秒）|間隔（秒）|간격 (초)|Интервал (с)
Text|Texto|Texto|Texte|Text|文字|テキスト|텍스트|Текст
Logo image|Imagem do logotipo|Logotipo|Image du logo|Logobild|徽标图片|ロゴ画像|로고 이미지|Логотип
Position|Posição|Posición|Position|Position|位置|位置|위치|Расположение
Opacity (%)|Opacidade (%)|Opacidad (%)|Opacité (%)|Deckkraft (%)|不透明度 (%)|不透明度 (%)|불투명도 (%)|Непрозрачность (%)
Size (%)|Tamanho (%)|Tamaño (%)|Taille (%)|Größe (%)|大小 (%)|サイズ (%)|크기 (%)|Размер (%)
Width (px)|Largura (px)|Ancho (px)|Largeur (px)|Breite (px)|宽度 (px)|幅 (px)|너비 (px)|Ширина (px)
Height (px)|Altura (px)|Alto (px)|Hauteur (px)|Höhe (px)|高度 (px)|高さ (px)|높이 (px)|Высота (px)
Resize|Redimensionar|Cambiar tamaño|Redimensionner|Größe ändern|调整大小|サイズ変更|크기 변경|Изменить размер
Lock aspect ratio|Travar proporção|Bloquear proporción|Conserver les proportions|Seitenverhältnis sperren|锁定宽高比|縦横比を固定|가로세로 비율 잠금|Сохранить пропорции
Rows|Linhas|Filas|Lignes|Zeilen|行|行|행|Строки
Columns|Colunas|Columnas|Colonnes|Spalten|列|列|열|Столбцы
Line color|Cor da linha|Color de línea|Couleur du trait|Linienfarbe|线条颜色|線の色|선 색상|Цвет линии
Grayscale|Tons de cinza|Escala de grises|Niveaux de gris|Graustufen|灰度|グレースケール|회색조|Оттенки серого
Paper size|Tamanho do papel|Tamaño del papel|Format de papier|Papierformat|纸张大小|用紙サイズ|용지 크기|Формат бумаги
Mode|Modo|Modo|Mode|Modus|模式|モード|모드|Режим
Undo|Desfazer|Deshacer|Annuler l’action|Rückgängig|撤销|元に戻す|실행 취소|Отменить действие
Redo|Refazer|Rehacer|Rétablir|Wiederholen|重做|やり直す|다시 실행|Повторить
Layer|Camada|Capa|Calque|Ebene|图层|レイヤー|레이어|Слой
layers|camadas|capas|calques|Ebenen|图层|レイヤー|레이어|слоёв
Transparent background|Fundo transparente|Fondo transparente|Fond transparent|Transparenter Hintergrund|透明背景|透明背景|투명 배경|Прозрачный фон
Custom|Personalizado|Personalizado|Personnalisé|Benutzerdefiniert|自定义|カスタム|사용자 지정|Пользовательский
Original|Original|Original|Original|Original|原始|元のサイズ|원본|Оригинал
None|Nenhuma|Ninguna|Aucun|Keine|无|なし|없음|Нет
Save directly|Salvar diretamente|Guardar directamente|Enregistrer directement|Direkt speichern|直接保存|直接保存|직접 저장|Сохранить напрямую
Audio source|Origem do áudio|Origen de audio|Source audio|Audioquelle|音频来源|音声のソース|오디오 소스|Источник звука
Background color|Cor de fundo|Color de fondo|Couleur du fond|Hintergrundfarbe|背景颜色|背景色|배경색|Цвет фона
Brush size (px)|Tamanho do pincel (px)|Tamaño del pincel (px)|Taille du pinceau (px)|Pinselgröße (px)|画笔大小 (px)|ブラシサイズ (px)|브러시 크기 (px)|Размер кисти (пикс.)
Canvas ratio|Proporção da tela|Proporción del lienzo|Proportions du canevas|Leinwandformat|画布比例|キャンバス比率|캔버스 비율|Пропорции холста
Color tolerance|Tolerância de cor|Tolerancia de color|Tolérance de couleur|Farbtoleranz|颜色容差|色の許容値|색상 허용치|Допуск цвета
Custom target (MB)|Tamanho desejado (MB)|Tamaño deseado (MB)|Taille cible (Mo)|Zielgröße (MB)|目标大小 (MB)|目標サイズ (MB)|목표 크기 (MB)|Целевой размер (МБ)
Custom size|Tamanho personalizado|Tamaño personalizado|Taille personnalisée|Benutzerdefinierte Größe|自定义大小|カスタムサイズ|사용자 지정 크기|Свой размер
Quality mode|Modo por qualidade|Modo de calidad|Mode qualité|Qualitätsmodus|画质模式|品質モード|품질 모드|Режим качества
Default track|Faixa padrão|Pista predeterminada|Piste par défaut|Standardspur|默认音轨|既定のトラック|기본 트랙|Дорожка по умолчанию
Default quality|Qualidade padrão|Calidad predeterminada|Qualité par défaut|Standardqualität|默认画质|既定の品質|기본 품질|Качество по умолчанию
Duplicate layer|Duplicar camada|Duplicar capa|Dupliquer le calque|Ebene duplizieren|复制图层|レイヤーを複製|레이어 복제|Дублировать слой
Edge margin (%)|Margem (%)|Margen (%)|Marge (%)|Randabstand (%)|边距 (%)|余白 (%)|여백 (%)|Отступ (%)
Extract current frame|Extrair quadro atual|Extraer fotograma actual|Extraire l’image actuelle|Aktuelles Bild extrahieren|提取当前帧|現在のフレームを抽出|현재 프레임 추출|Извлечь текущий кадр
Fit layers to canvas|Ajustar as camadas à tela|Ajustar capas al lienzo|Ajuster les calques au canevas|Ebenen an Leinwand anpassen|图层适应画布|レイヤーをキャンバスに合わせる|레이어를 캔버스에 맞춤|Подогнать слои под холст
JPEG background|Fundo do JPEG|Fondo JPEG|Fond JPEG|JPEG-Hintergrund|JPEG 背景|JPEG の背景|JPEG 배경|Фон JPEG
Label cells|Rotular células|Etiquetar celdas|Nommer les cases|Zellen beschriften|标记单元格|セルにラベルを付ける|셀에 라벨 표시|Подписать ячейки
Line width (px)|Largura da linha (px)|Grosor de línea (px)|Épaisseur du trait (px)|Linienstärke (px)|线宽 (px)|線の太さ (px)|선 두께 (px)|Толщина линии (пикс.)
Match source AAC|Copiar AAC compatível|Copiar AAC compatible|Copier l’AAC compatible|Kompatibles AAC kopieren|复制兼容的 AAC|互換 AAC をコピー|호환되는 AAC 복사|Копировать совместимый AAC
Fast cut (keyframe stream copy)|Corte rápido (cópia por quadro-chave)|Corte rápido por fotograma clave|Coupe rapide aux images clés|Schnellschnitt am Schlüsselbild|按关键帧快速剪切|キーフレームで高速カット|키프레임으로 빠르게 자르기|Быстрая обрезка по ключевым кадрам
Copy compatible streams|Copiar faixas compatíveis|Copiar pistas compatibles|Copier les flux compatibles|Kompatible Streams kopieren|复制兼容的流|互換ストリームをコピー|호환 스트림 복사|Копировать совместимые потоки
Move layer backward|Enviar camada para trás|Bajar capa|Reculer le calque|Ebene nach hinten|下移图层|レイヤーを背面へ|레이어 뒤로 보내기|Переместить слой назад
Move layer forward|Trazer camada para frente|Subir capa|Avancer le calque|Ebene nach vorn|上移图层|レイヤーを前面へ|레이어 앞으로 가져오기|Переместить слой вперёд
Next frame|Próximo quadro|Siguiente fotograma|Image suivante|Nächstes Bild|下一帧|次のフレーム|다음 프레임|Следующий кадр
Preview time|Posição da prévia|Tiempo de vista previa|Position de l’aperçu|Vorschauposition|预览时间|プレビュー位置|미리보기 시간|Позиция просмотра
Previous frame|Quadro anterior|Fotograma anterior|Image précédente|Vorheriges Bild|上一帧|前のフレーム|이전 프레임|Предыдущий кадр
Remove layer|Remover camada|Quitar capa|Supprimer le calque|Ebene entfernen|移除图层|レイヤーを削除|레이어 제거|Удалить слой
Pick background color|Selecionar cor de fundo|Seleccionar el color del fondo|Choisir la couleur de fond|Hintergrundfarbe wählen|选取背景颜色|背景色を選ぶ|배경색 선택|Выбрать цвет фона
Erase brush|Pincel de apagar|Pincel de borrado|Pinceau d’effacement|Radierpinsel|擦除画笔|消去ブラシ|지우기 브러시|Кисть для стирания
Restore brush|Pincel de restaurar|Pincel de restauración|Pinceau de restauration|Wiederherstellungspinsel|恢复画笔|復元ブラシ|복원 브러시|Кисть для восстановления
Remove sampled color|Remover cor selecionada|Quitar el color seleccionado|Supprimer la couleur échantillonnée|Gewählte Farbe entfernen|移除所选颜色|選んだ色を削除|선택한 색 제거|Удалить выбранный цвет
Reset mask|Redefinir máscara|Restablecer máscara|Réinitialiser le masque|Maske zurücksetzen|重置蒙版|マスクをリセット|마스크 초기화|Сбросить маску
Set end at playhead|Definir fim na posição atual|Fijar final en la posición actual|Placer la fin au curseur|Ende am Abspielkopf setzen|以播放头设为结束|再生位置を終了点に設定|재생 위치를 끝점으로 지정|Конец в позиции воспроизведения
Set start at playhead|Definir início na posição atual|Fijar inicio en la posición actual|Placer le début au curseur|Start am Abspielkopf setzen|以播放头设为开始|再生位置を開始点に設定|재생 위치를 시작점으로 지정|Начало в позиции воспроизведения
Start range handle|Controle do início|Control del inicio|Poignée de début|Startgriff|开始位置滑块|開始位置ハンドル|시작 위치 조절|Ползунок начала
End range handle|Controle do fim|Control del final|Poignée de fin|Endgriff|结束位置滑块|終了位置ハンドル|끝 위치 조절|Ползунок конца
Snap to grid|Alinhar à grade|Ajustar a la cuadrícula|Aligner sur la grille|Am Raster ausrichten|吸附到网格|グリッドにスナップ|격자에 맞춤|Привязать к сетке
Speed preset|Velocidade predefinida|Velocidad predefinida|Vitesse prédéfinie|Tempo-Voreinstellung|速度预设|速度プリセット|속도 프리셋|Предустановка скорости
Use MP4 rotation metadata when compatible|Usar metadados de rotação MP4 quando compatível|Usar metadatos de rotación MP4 compatibles|Utiliser les métadonnées de rotation MP4 compatibles|MP4-Drehmetadaten verwenden, wenn möglich|兼容时使用 MP4 旋转元数据|対応時は MP4 回転メタデータを使用|호환 시 MP4 회전 메타데이터 사용|Использовать метаданные поворота MP4
When this clip ends|Quando o clipe terminar|Al finalizar el clip|À la fin du clip|Am Clipende|片段结束时|クリップ終了時|클립이 끝날 때|В конце клипа
Freeze|Congelar|Congelar|Figer|Standbild|定格|静止|정지 화면|Стоп-кадр
Infinite|Infinito|Infinito|Infini|Unendlich|无限|無限|무한|Бесконечно
Once|Uma vez|Una vez|Une fois|Einmal|一次|1 回|한 번|Один раз
Three times|Três vezes|Tres veces|Trois fois|Dreimal|三次|3 回|세 번|Три раза
Play collage|Reproduzir colagem|Reproducir collage|Lire le collage|Collage abspielen|播放拼贴|コラージュを再生|콜라주 재생|Воспроизвести коллаж
Pause collage|Pausar colagem|Pausar collage|Mettre le collage en pause|Collage pausieren|暂停拼贴|コラージュを一時停止|콜라주 일시정지|Приостановить коллаж
Crop left (%)|Corte esquerdo (%)|Recorte izquierdo (%)|Recadrage gauche (%)|Links beschneiden (%)|左侧裁剪 (%)|左の切り抜き (%)|왼쪽 자르기 (%)|Обрезка слева (%)
Crop right (%)|Corte direito (%)|Recorte derecho (%)|Recadrage droit (%)|Rechts beschneiden (%)|右侧裁剪 (%)|右の切り抜き (%)|오른쪽 자르기 (%)|Обрезка справа (%)
Crop top (%)|Corte superior (%)|Recorte superior (%)|Recadrage haut (%)|Oben beschneiden (%)|顶部裁剪 (%)|上の切り抜き (%)|위쪽 자르기 (%)|Обрезка сверху (%)
Crop bottom (%)|Corte inferior (%)|Recorte inferior (%)|Recadrage bas (%)|Unten beschneiden (%)|底部裁剪 (%)|下の切り抜き (%)|아래쪽 자르기 (%)|Обрезка снизу (%)
Layer width (%)|Largura da camada (%)|Ancho de capa (%)|Largeur du calque (%)|Ebenenbreite (%)|图层宽度 (%)|レイヤー幅 (%)|레이어 너비 (%)|Ширина слоя (%)
Layer height (%)|Altura da camada (%)|Alto de capa (%)|Hauteur du calque (%)|Ebenenhöhe (%)|图层高度 (%)|レイヤー高さ (%)|레이어 높이 (%)|Высота слоя (%)
Corner rounding (%)|Arredondamento dos cantos (%)|Redondeo de esquinas (%)|Arrondi des coins (%)|Eckenradius (%)|圆角 (%)|角丸 (%)|모서리 둥글기 (%)|Скругление углов (%)
Tile 3 × 3|Repetir em grade 3 × 3|Repetir en cuadrícula 3 × 3|Répéter en grille 3 × 3|Als 3 × 3 Raster wiederholen|按 3 × 3 平铺|3 × 3 に並べる|3 × 3 타일|Повторить сеткой 3 × 3
90° right|90° à direita|90° a la derecha|90° à droite|90° nach rechts|向右 90°|右に 90°|오른쪽으로 90°|90° вправо
90° left|90° à esquerda|90° a la izquierda|90° à gauche|90° nach links|向左 90°|左に 90°|왼쪽으로 90°|90° влево
cell|célula|celda|case|Zelle|格|セル|셀|ячейка
Convert a video or copy compatible streams to a new container.|Converta um vídeo ou copie faixas compatíveis para outro formato.|Convierte un vídeo o copia pistas compatibles a otro contenedor.|Convertissez une vidéo ou copiez les flux compatibles dans un autre conteneur.|Konvertieren Sie ein Video oder kopieren Sie kompatible Streams in einen neuen Container.|转换视频或将兼容流复制到新容器。|動画を変換するか、互換ストリームを別のコンテナにコピーします。|동영상을 변환하거나 호환 스트림을 새 컨테이너로 복사합니다.|Преобразуйте видео или скопируйте совместимые потоки в другой контейнер.
Compress a video to a quality or file-size target.|Comprima um vídeo por qualidade ou tamanho desejado.|Comprime un vídeo según la calidad o el tamaño deseado.|Compressez une vidéo selon la qualité ou la taille souhaitée.|Komprimieren Sie ein Video auf eine gewünschte Qualität oder Dateigröße.|按画质或目标文件大小压缩视频。|画質や目標ファイルサイズに合わせて動画を圧縮します。|품질이나 목표 파일 크기에 맞춰 동영상을 압축합니다.|Сожмите видео до нужного качества или размера.
Set an exact range or copy it at the nearest keyframe.|Defina um trecho exato ou copie a partir de quadros-chave.|Define un tramo exacto o copia desde el fotograma clave más cercano.|Sélectionnez une plage exacte ou copiez au niveau de l’image clé la plus proche.|Wählen Sie einen exakten Bereich oder kopieren Sie ab dem nächsten Schlüsselbild.|精确选择范围，或从最近的关键帧复制。|範囲を正確に指定するか、最寄りのキーフレームでコピーします。|정확한 범위를 지정하거나 가장 가까운 키프레임에서 복사합니다.|Задайте точный диапазон или скопируйте его от ближайшего ключевого кадра.
Save an audio track from a video.|Salve uma faixa de áudio de um vídeo.|Guarda una pista de audio de un vídeo.|Enregistrez une piste audio d’une vidéo.|Speichern Sie eine Audiospur aus einem Video.|保存视频中的音轨。|動画の音声トラックを保存します。|동영상의 오디오 트랙을 저장합니다.|Сохраните аудиодорожку из видео.
Correct orientation or mirror the picture.|Corrija a orientação ou espelhe a imagem.|Corrige la orientación o refleja la imagen.|Corrigez l’orientation ou retournez l’image.|Korrigieren Sie die Ausrichtung oder spiegeln Sie das Bild.|校正方向或镜像画面。|向きを修正したり映像を反転したりできます。|방향을 바로잡거나 영상을 뒤집습니다.|Исправьте ориентацию или отразите изображение.
Adjust video speed with synchronized audio or mute.|Ajuste a velocidade mantendo o áudio sincronizado ou silencie.|Ajusta la velocidad con audio sincronizado o sin sonido.|Ajustez la vitesse avec un son synchronisé ou coupez le son.|Ändern Sie das Tempo mit synchronem Ton oder ohne Ton.|调整视频速度，并保持音画同步或静音。|音声を同期させるかミュートして動画速度を変更します。|소리를 동기화하거나 음소거한 상태로 속도를 바꿉니다.|Измените скорость, сохранив синхронный звук или отключив его.
Reverse a selected part of the video.|Reproduza um trecho do vídeo ao contrário.|Invierte un tramo del vídeo.|Inversez une partie sélectionnée de la vidéo.|Kehren Sie einen ausgewählten Videoabschnitt um.|倒放选定的视频片段。|動画の選択範囲を逆再生します。|선택한 동영상 구간을 역재생합니다.|Обратите выбранный фрагмент видео.
Save still images from a video individually or as a ZIP.|Salve quadros de um vídeo individualmente ou em ZIP.|Guarda fotogramas por separado o en un ZIP.|Enregistrez les images d’une vidéo séparément ou dans un ZIP.|Speichern Sie Einzelbilder separat oder als ZIP.|单独保存视频静帧或打包为 ZIP。|動画の静止画を個別または ZIP で保存します。|동영상 프레임을 각각 또는 ZIP으로 저장합니다.|Сохраните кадры по отдельности или в ZIP-архиве.
Turn part of a video into a looping animation.|Transforme um trecho do vídeo em uma animação.|Convierte un tramo en una animación en bucle.|Transformez un extrait vidéo en animation en boucle.|Erstellen Sie aus einem Videoabschnitt eine animierte Schleife.|将视频片段变成循环动画。|動画の一部をループアニメーションにします。|동영상의 일부를 반복 애니메이션으로 만듭니다.|Превратите фрагмент видео в зацикленную анимацию.
Place text or a logo over a video.|Sobreponha texto ou um logotipo a um vídeo.|Añade texto o un logotipo a un vídeo.|Ajoutez du texte ou un logo à une vidéo.|Legen Sie Text oder ein Logo über ein Video.|为视频添加文字或徽标。|動画にテキストやロゴを重ねます。|동영상 위에 텍스트나 로고를 넣습니다.|Наложите текст или логотип на видео.
Arrange several playing videos on one canvas.|Posicione vários vídeos no mesmo quadro.|Organiza varios vídeos en un mismo lienzo.|Disposez plusieurs vidéos sur le même canevas.|Ordnen Sie mehrere laufende Videos auf einer Leinwand an.|在一张画布上排列多个播放中的视频。|複数の動画を一つのキャンバスに配置します。|한 캔버스에 여러 동영상을 배치합니다.|Разместите несколько видео на одном холсте.
Resize an image and change its format.|Redimensione uma imagem e altere seu formato.|Cambia el tamaño y el formato de una imagen.|Redimensionnez une image et changez son format.|Ändern Sie Größe und Format eines Bildes.|调整图像大小并转换格式。|画像のサイズと形式を変更します。|이미지의 크기와 형식을 변경합니다.|Измените размер и формат изображения.
Place text or a logo over an image.|Sobreponha texto ou um logotipo a uma imagem.|Añade texto o un logotipo a una imagen.|Ajoutez du texte ou un logo à une image.|Legen Sie Text oder ein Logo über ein Bild.|为图像添加文字或徽标。|画像にテキストやロゴを重ねます。|이미지 위에 텍스트나 로고를 넣습니다.|Наложите текст или логотип на изображение.
Add a labeled grid for drawing from a reference.|Adicione uma grade rotulada para desenhar a partir de uma referência.|Añade una cuadrícula numerada para dibujar a partir de una referencia.|Ajoutez une grille annotée pour dessiner d’après une référence.|Fügen Sie einer Zeichenvorlage ein beschriftetes Raster hinzu.|为参考图添加带标签的绘画网格。|参照画像にラベル付きの描画グリッドを加えます。|참고 이미지에 셀 이름이 있는 격자를 추가합니다.|Добавьте подписанную сетку для рисования по образцу.
Remove a background color or refine an AI cutout with brushes.|Remova uma cor de fundo ou corrija um recorte com pincéis.|Quita un color de fondo o retoca un recorte de IA con pinceles.|Retirez une couleur de fond ou retouchez un détourage IA au pinceau.|Entfernen Sie eine Hintergrundfarbe oder bessern Sie eine KI-Freistellung mit Pinseln aus.|移除背景颜色或用画笔修整 AI 抠图。|背景色を取り除くか、AI の切り抜きをブラシで調整します。|배경색을 제거하거나 브러시로 AI 누끼를 다듬습니다.|Удалите цвет фона или поправьте вырезанную ИИ область кистью.
Crop and arrange several images on one canvas.|Corte e organize várias imagens na mesma tela.|Recorta y organiza varias imágenes en un lienzo.|Recadrez et disposez plusieurs images sur un canevas.|Schneiden Sie mehrere Bilder zu und ordnen Sie sie auf einer Leinwand an.|在同一画布上裁剪并排列多个图像。|複数の画像を切り抜いて一つのキャンバスに配置します。|여러 이미지를 자르고 한 캔버스에 배치합니다.|Обрежьте и разместите несколько изображений на одном холсте.
`;

export const QUICK_TERMS: ReadonlyMap<string, readonly string[]> = new Map(terms.trim().split('\n').map(line => {
  const columns = line.split('|');
  return [columns[0], columns];
}));
