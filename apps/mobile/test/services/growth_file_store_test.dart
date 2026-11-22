import 'dart:io';
import 'dart:typed_data';

import 'package:babyplan/services/growth_file_store.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('LocalGrowthFileStore', () {
    late Directory temporary;
    late LocalGrowthFileStore files;

    setUp(() async {
      temporary = await Directory.systemTemp.createTemp(
        'babyplan_growth_files_',
      );
      files = LocalGrowthFileStore(rootProvider: () async => temporary);
    });

    tearDown(() async {
      if (await temporary.exists()) await temporary.delete(recursive: true);
    });

    test('只复制用户选择的有效照片，并识别真实图片类型与摘要', () async {
      final source = File(
        '${temporary.path}${Platform.pathSeparator}source.jpg',
      );
      await source.writeAsBytes(
        Uint8List.fromList([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
      );

      final copied = await files.copyPhotos(
        familyId: 'family-1',
        childId: 'child-1',
        recordId: 'record-1',
        sourcePaths: [source.path],
      );

      expect(copied, hasLength(1));
      expect(copied.single.mime, 'image/jpeg');
      expect(copied.single.byteSize, 7);
      expect(copied.single.sha256, hasLength(64));
      expect(File(copied.single.localPath).existsSync(), isTrue);
      expect(
        copied.single.localPath,
        contains(
          '${Platform.pathSeparator}private-growth'
          '${Platform.pathSeparator}family-1'
          '${Platform.pathSeparator}child-1',
        ),
      );
    });

    test('损坏文件拒绝登记并清理本次已复制的副本', () async {
      final valid = File('${temporary.path}${Platform.pathSeparator}valid.png');
      await valid.writeAsBytes(
        Uint8List.fromList([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
      );
      final damaged = File(
        '${temporary.path}${Platform.pathSeparator}damaged.jpg',
      );
      await damaged.writeAsString('这不是一张照片');

      await expectLater(
        files.copyPhotos(
          familyId: 'family-1',
          childId: 'child-1',
          recordId: 'record-2',
          sourcePaths: [valid.path, damaged.path],
        ),
        throwsA(isA<FormatException>()),
      );
      final recordDirectory = Directory(
        '${temporary.path}${Platform.pathSeparator}private-growth'
        '${Platform.pathSeparator}family-1'
        '${Platform.pathSeparator}child-1'
        '${Platform.pathSeparator}record-2',
      );
      expect(
        await recordDirectory.list().where((entry) => entry is File).isEmpty,
        isTrue,
      );
    });

    test('单张超过 20MB 时在读取前拒绝，且最多只接受五张', () async {
      final oversized = File(
        '${temporary.path}${Platform.pathSeparator}oversized.jpg',
      );
      final handle = await oversized.open(mode: FileMode.write);
      await handle.truncate(maxGrowthPhotoBytes + 1);
      await handle.close();

      await expectLater(
        files.copyPhotos(
          familyId: 'family-1',
          childId: 'child-1',
          recordId: 'record-3',
          sourcePaths: [oversized.path],
        ),
        throwsA(isA<FormatException>()),
      );
      await expectLater(
        files.copyPhotos(
          familyId: 'family-1',
          childId: 'child-1',
          recordId: 'record-4',
          sourcePaths: List.filled(6, oversized.path),
        ),
        throwsA(isA<FormatException>()),
      );
    });

    test('私有文件读取和删除拒绝越过应用照片目录', () async {
      final outside = File(
        '${temporary.path}${Platform.pathSeparator}outside.jpg',
      );
      await outside.writeAsBytes([0xff, 0xd8, 0xff]);

      await expectLater(
        files.readPhoto(outside.path),
        throwsA(isA<FileSystemException>()),
      );
      await expectLater(
        files.deletePhoto(outside.path),
        throwsA(isA<FileSystemException>()),
      );
      expect(await outside.exists(), isTrue);
    });
  });
}
